/**
 * One live audio session: PCM in, attributed utterances out.
 *
 * Two passes, because the two things a transcript needs arrive at different
 * speeds. The live pass is the realtime socket plus voiceprint clustering, and
 * it puts text on screen within a second. The final pass runs when recording
 * stops: the retained WAV is transcribed by whisper and diarized by pyannote,
 * the two are joined at word level, and the result *replaces* the live pass's
 * guesses about who said what. Re-emitting a UtteranceEvent under the same
 * utterance_id is a revision, so the correction lands in place on a transcript
 * the user is already reading.
 *
 * The split is forced by speed, not by taste. pyannote runs at about 1.2x
 * realtime on CPU — 40 minutes of compute for a 48-minute conversation — so it
 * cannot be in the live path at any price, and the live path cannot be as good
 * as it is. Live text keeps appearing immediately with provisional speakers;
 * the final pass corrects them.
 *
 * Ingestion never waits on any of it. pushAudio only advances the clock and
 * hands the frame on; clustering, finalization and attribution run on a
 * single-flight worker behind it, so a slow sidecar costs identification
 * latency and never costs audio.
 */

import { readFile } from 'node:fs/promises'
import type { Collection } from 'mongodb'
import {
  OWNER_ID,
  SESSION_LINK_THRESHOLD,
  type AmeliaStepEvent,
  type IdentityConfidence,
  type SpeakerPendingEvent,
  type Utterance,
  type UtteranceEvent,
} from '../../shared/contracts'
import type { AmeliaBus } from '../lib/bus'
import type { AttributionInput, AttributionResult } from '../identity'
import { audioConfig, type AudioConfig } from './config'
import { agglomerateByAverageLinkage } from './agglomerate'
import { diarizeAudio, type SpeakerTurn } from './diarize-sidecar'
import { embedPcm, embedPcmForClustering } from './embed-client'
import { transcribeWithTimings } from './whisper-client'
import { SessionRecorder } from './session-recorder'
import { clusterPendingTurns, WINDOW_LINK_MIN, WINDOW_MARGIN } from './cluster-pass'
import { cosine, SpeakerClusterer } from './speaker-clusterer'
import { StreamBuffer, UNKNOWN_SPEAKER } from './stream-buffer'
import { SAMPLE_RATE, type PendingUtterance, type StreamProvider } from './types'
import { readWav } from './wav'
import { exclusiveTurns } from './overlap'
import { joinWordsToSpeakers, speechMsBySpeaker, type AttributedTurn, type TimedWord } from './word-join'
import {
  bestPool,
  poolableStretches,
  rewriteTurns,
  concatSamples,
  sentencesFromWords,
  stretchesWithinBudget,
  SENTENCE_TRUST_MS,
} from './sentence-pass'

/**
 * How far behind the live edge an utterance must be to count as final.
 *
 * This is a correctness margin, not a latency budget: it only has to outlast
 * the provider's own revisions. It used to be 1200 ms, which put more than a
 * second of dead air in front of every line on screen for no benefit.
 */
const HOLDBACK_MS = 300

/**
 * Consecutive failures in one subsystem before the client is told.
 *
 * A dead sidecar used to be indistinguishable from a room full of people who
 * had not said enough yet: both produced console noise and no names. One
 * transient failure is genuinely not worth a banner. Two is: identity is asked
 * only at the rungs of the attempt ladder, so a whole three-minute conversation
 * may only ask two or three times, and waiting for a third strike can mean
 * waiting for a conversation that never comes.
 */
const FAILURES_BEFORE_ANNOUNCING = 2

type Subsystem = 'embedding' | 'identity' | 'diarization' | 'pipeline'

/**
 * Consolidation passes. One, measured.
 *
 * Repeating it is tempting — single-link cannot see a merge that only becomes
 * visible after an earlier one — but three runs of each on the live path said
 * otherwise: one pass gave 27.1 / 30.7 / 28.5 % speaker error, four gave
 * 30.8 / 55.7 / 29.8 %. The extra rounds do not reliably find anything and they
 * occasionally over-merge catastrophically, which is the one direction this
 * pipeline is not allowed to fail in. AUDIO_CONSOLIDATION_ROUNDS overrides it
 * for anyone re-measuring on different audio.
 */
const CONSOLIDATION_ROUNDS = 1

/**
 * The seam onto the identity lane, narrowed to what a session actually calls.
 *
 * Structurally satisfied by IdentityService, so the real thing drops in and a
 * test double stays two methods long. `attributeSession` is optional only
 * because doubles rarely need it; the final pass uses it whenever it exists,
 * because assigning every cluster of a session at once is the only thing that
 * stops two distinct voices in one room being handed the same person.
 */
export interface AttributionService {
  attributeSpeaker(input: AttributionInput): Promise<AttributionResult>
  attributeSession?(input: {
    conversation_id: string
    clusters: (Omit<AttributionInput, 'conversation_id'> & { session_speaker: string })[]
  }): Promise<Record<string, AttributionResult>>
}

export interface SessionOptions {
  conversationId: string
  bus: AmeliaBus
  provider: StreamProvider
  identity: AttributionService | null
  utterances: Collection<Utterance> | null
  now?: () => Date
  config?: AudioConfig
  /** Off for tests and for callers that supply their own retention. */
  recorder?: SessionRecorder | null
  /**
   * Proper nouns to bias transcription toward, most likely first.
   *
   * Injected, because the names worth biasing toward are the people this user
   * has met and that is the identity layer's knowledge, not the audio lane's.
   * Read only when AUDIO_ASR_VOCABULARY is on — see the measurement on
   * AudioConfig.vocabularyEnabled for why it is off.
   */
  vocabulary?: () => readonly string[] | Promise<readonly string[]>
}

interface EmittedUtterance {
  utterance_id: string
  session_speaker: string
  person_id?: string
  identity_confidence?: IdentityConfidence
  voiceprint_id?: string
  text: string
  start_ms: number
  end_ms: number
  is_final: boolean
}

export interface FinalPassReport {
  ran: boolean
  reason?: string
  /** The speakers pyannote found in this recording. */
  labels: string[]
  /** Utterances the final pass changed, including ones it created. */
  corrected: number
  /** Lines the final pass produced beyond the ones the live pass had. */
  split?: number
  /** Live lines the rebuilt transcript replaced entirely. */
  superseded?: number
  segments: SpeakerTurn[]
  /** Words the join could put on a speaker, and words in all. */
  attributedWords?: number
  totalWords?: number
  /** Speech with two or more people talking at once. */
  overlapMs?: number
  /** Wall-clock the diarizer spent, against the audio it was given. */
  diarizeMs?: number
  /** Audio actually retained, and whether the retention cap cut it short. */
  retainedMs?: number
  truncated?: boolean
  /**
   * Speech the correction could not cover because retention stopped early.
   *
   * Non-zero means the transcript is deliberately left holding two label
   * spaces: corrected inside the retained span, live-pass labels outside it.
   * That is ugly, and it is still better than the alternative, which is a
   * rebuilt transcript that stops where the audio stopped and quietly loses the
   * last three minutes of the conversation.
   */
  uncoveredMs?: number
  /**
   * Largest live cluster's share of clustered speech, and the number of
   * clusters with enough speech to pool.
   *
   * The runaway-cluster signal described on nearestCluster in cluster-pass.ts,
   * finally computed. Over 80 runs of dorm-9pm it separated the two modes with
   * no overlap: 40-53% in the 78 good runs, 77-96% in the 2 bad ones. It is
   * reported and NOT acted on — it says something about the live pass, which
   * the final pass now replaces wholesale, so what it is for is telling a
   * reader of the live transcript that the names on it are unreliable until the
   * correction lands.
   */
  largestLiveClusterShare?: number
  poolableLiveClusters?: number
}

export class AudioSession {
  private readonly buffer: StreamBuffer
  private readonly config: AudioConfig
  private readonly recorder: SessionRecorder | null
  /** Keyed by start_ms, rebuilt every finalize. See claim() for why. */
  private readonly emitted = new Map<number, EmittedUtterance>()
  /** Session speakers resolved to people, and those currently being resolved. */
  private readonly resolved = new Map<
    string,
    { person_id: string; voiceprint_id: string; identity_confidence: IdentityConfidence }
  >()
  private readonly resolving = new Set<string>()
  private readonly now: () => Date
  /** Decides which provider turns are the same voice. See speaker-clusterer.ts. */
  private readonly clusterer = new SpeakerClusterer()
  /** Provider turns already handed to the clusterer. */
  private readonly submitted = new Set<string>()
  /** Cluster -> pooled speech at which it is worth asking identity again. */
  private readonly nextAttemptMs = new Map<string, number>()
  /** Clusters we have already told the client are being attributed. */
  private readonly announced = new Set<string>()
  /** Why identity has not named a cluster, straight from its own vocabulary. */
  private readonly pendingReason = new Map<string, SpeakerPendingEvent['reason']>()

  /** Running sum and count of every embedding taken this session. */
  private embeddingSum: number[] | null = null
  private embeddingCount = 0

  private worker: Promise<void> | null = null
  private workPending = false
  /**
   * Consecutive failures per subsystem, and why.
   *
   * Counted separately on purpose. A single shared counter meant a healthy
   * sidecar reset the count every time it embedded a turn, so an identity
   * service that failed on every call in between never reached the threshold
   * and never surfaced — the exact silence this is here to end.
   */
  private readonly failures = new Map<string, { count: number; message: string; announced: boolean }>()

  constructor(private readonly options: SessionOptions) {
    this.config = options.config ?? audioConfig()
    this.buffer = new StreamBuffer(options.conversationId)
    this.recorder =
      options.recorder !== undefined
        ? options.recorder
        : this.config.retainEnabled
          ? new SessionRecorder(options.conversationId, this.config)
          : null
    this.now = options.now ?? (() => new Date())
    options.provider.onSegments((segments) => this.buffer.addSegments(segments))
    options.provider.onWords((words) => this.buffer.addWords(words))
  }

  get conversationId(): string {
    return this.options.conversationId
  }

  get elapsedMs(): number {
    return this.buffer.elapsedMs
  }

  /** Where the session audio was retained, if it was. */
  get recordingPath(): string | null {
    return this.recorder?.path ?? null
  }

  /**
   * Mean of every embedding taken this session, for the identity layer to
   * subtract before comparing anything. Null until something has been embedded.
   */
  get sessionMean(): number[] | null {
    if (!this.embeddingSum || this.embeddingCount === 0) return null
    return this.embeddingSum.map((total) => total / this.embeddingCount)
  }

  /** Non-null when identification has been failing rather than merely waiting. */
  get degradedReason(): string | null {
    for (const state of this.failures.values()) {
      if (state.count >= FAILURES_BEFORE_ANNOUNCING) return state.message
    }
    return null
  }

  /** The live view of who said what, for the replay harness and the final pass. */
  speakerOf(utteranceId: string): string | undefined {
    for (const record of this.emitted.values()) {
      if (record.utterance_id === utteranceId) return record.session_speaker
    }
    return undefined
  }

  get transcript(): readonly Readonly<EmittedUtterance>[] {
    return [...this.emitted.values()].sort((a, b) => a.start_ms - b.start_ms)
  }

  /**
   * Feed one chunk of float32 PCM.
   *
   * Deliberately does no network work. Everything downstream is scheduled, so
   * a sidecar taking two seconds delays a name, not the next frame of audio.
   */
  async pushAudio(pcm: Float32Array): Promise<void> {
    this.buffer.pushAudio(pcm)
    this.recorder?.write(pcm)
    this.options.provider.pushAudio(pcm, this.buffer.elapsedMs)
    this.schedule()
  }

  /** Ask the provider to flush its trailing turn, then finalize the result. */
  async end(): Promise<void> {
    let providerError: unknown
    try {
      await this.options.provider.close()
    } catch (error) {
      providerError = error
    }
    await this.drain()
    await this.clusterTurns()
    // Nothing more is coming, so held-back turns take their best guess now
    // rather than staying nameless.
    for (const assignment of this.clusterer.flush()) {
      this.buffer.setSpeakerAlias(assignment.label, assignment.clusterId)
    }
    await this.consolidateClusters()
    await this.finalize(Number.POSITIVE_INFINITY)
    await this.maybeAttribute()
    for (const [subsystem, state] of this.failures) {
      console.error(`${state.count} ${subsystem} failures in ${this.conversationId}: ${state.message}`)
    }
    if (providerError) throw providerError
  }

  /** Wait for scheduled clustering, finalization and attribution to settle. */
  async drain(): Promise<void> {
    while (this.worker) await this.worker
  }

  private schedule(): void {
    if (this.worker) {
      this.workPending = true
      return
    }
    this.worker = this.runWork().finally(() => {
      this.worker = null
      if (this.workPending) {
        this.workPending = false
        this.schedule()
      }
    })
  }

  private async runWork(): Promise<void> {
    try {
      await this.clusterTurns()
      await this.finalize(this.buffer.elapsedMs - HOLDBACK_MS)
      await this.maybeAttribute()
    } catch (error) {
      // The worker is the only thing between here and an unhandled rejection
      // that would take the socket down with it. Ingestion continues.
      this.recordFailure('pipeline', error, 'audio worker')
    }
  }

  /** Fold newly-arrived provider turns into speaker clusters. See cluster-pass.ts. */
  private async clusterTurns(): Promise<void> {
    await clusterPendingTurns({
      buffer: this.buffer,
      clusterer: this.clusterer,
      config: this.config,
      submitted: this.submitted,
      onEmbedding: (vector) => this.recordEmbedding(vector),
      onSuccess: () => this.recordSuccess('embedding'),
      onFailure: (error, context) => this.recordFailure('embedding', error, context),
    })
  }

  /**
   * Emit everything the buffer currently believes: settled utterances as final,
   * and whatever is still being said as a revisable draft.
   *
   * The draft half is what makes the transcript feel live. Text used to appear
   * only once its turn was complete and had fallen behind the holdback, so a
   * long sentence sat invisible until the speaker stopped talking. Drafts share
   * the utterance_id their final version will use, so the client replaces in
   * place rather than showing the line twice.
   *
   * Every call rebuilds the whole map, and that is the point. The buffer
   * recomputes utterances from scratch precisely because clustering changes the
   * answer: a turn labelled `turn-31` at 40 s becomes `cluster-0` a moment
   * later, and the two lines it used to be merge into one. Keying records by
   * start_ms alone left the pre-merge record stranded in the map forever, still
   * carrying its raw provider label. On the dorm recording that alone
   * manufactured twenty-four phantom speakers out of three.
   */
  private async finalize(cutoffMs: number): Promise<void> {
    const pendings = this.buffer
      .utterances()
      .filter((pending) => pending.session_speaker !== UNKNOWN_SPEAKER)
    const unclaimed = new Set(this.emitted.values())
    const rebuilt = new Map<number, EmittedUtterance>()
    const updates: { pending: PendingUtterance; isFinal: boolean; previous?: EmittedUtterance }[] = []

    for (const pending of pendings) {
      const previous = this.claim(pending, unclaimed)
      if (previous) unclaimed.delete(previous)
      updates.push({ pending, isFinal: pending.end_ms <= cutoffMs, previous })
    }
    // Anything left over was absorbed into a neighbour by a relabelling. It is
    // no longer part of the transcript, so it must stop being part of it here.
    this.emitted.clear()
    for (const { pending, isFinal, previous } of updates) {
      const identity = this.resolved.get(pending.session_speaker)
      const record: EmittedUtterance = {
        utterance_id: previous?.utterance_id ?? crypto.randomUUID(),
        session_speaker: pending.session_speaker,
        person_id: identity?.person_id,
        identity_confidence: identity?.identity_confidence,
        voiceprint_id: identity?.voiceprint_id,
        text: pending.text,
        start_ms: pending.start_ms,
        end_ms: pending.end_ms,
        is_final: isFinal,
      }
      rebuilt.set(record.start_ms, record)
      if (previous && unchanged(previous, record)) continue
      // Drafts are not written to the database: they are superseded within a
      // second or two, and persisting each keystroke of a sentence would triple
      // the write volume for nothing.
      if (isFinal) await this.persist(record)
      this.emitEvent(record)
    }
    for (const [startMs, record] of rebuilt) this.emitted.set(startMs, record)
  }

  /**
   * Find the record a pending utterance is a revision of.
   *
   * Keying purely on start_ms was fine right up until a provider moved one. A
   * streaming transcription that re-times its turn — which OpenAI Realtime does
   * constantly, and which the last seconds of a session do worst — then landed
   * on a fresh key, minted a fresh utterance_id, and the same sentence appeared
   * twice on screen with only one copy carrying the speaker's name. Greatest
   * time overlap identifies the line instead, and each old record can be
   * claimed only once so a merge cannot duplicate an id.
   */
  private claim(pending: PendingUtterance, unclaimed: Set<EmittedUtterance>): EmittedUtterance | undefined {
    const exact = [...unclaimed].find((record) => record.start_ms === pending.start_ms)
    if (exact) return exact
    let best: { record: EmittedUtterance; overlap: number } | undefined
    for (const record of unclaimed) {
      const overlap = Math.min(record.end_ms, pending.end_ms) - Math.max(record.start_ms, pending.start_ms)
      if (overlap <= 0) continue
      if (!best || overlap > best.overlap) best = { record, overlap }
    }
    return best?.record
  }

  private async persist(record: EmittedUtterance): Promise<void> {
    const collection = this.options.utterances
    if (!collection) return
    const timestamp = this.now().toISOString()
    await collection.updateOne(
      { _id: record.utterance_id },
      {
        $set: {
          owner_id: OWNER_ID,
          conversation_id: this.options.conversationId,
          person_id: record.person_id,
          identity_confidence: record.identity_confidence,
          voiceprint_id: record.voiceprint_id,
          text: record.text,
          start_ms: record.start_ms,
          end_ms: record.end_ms,
          is_final: true,
          updated_at: timestamp,
        },
        $setOnInsert: { created_at: timestamp },
      },
      { upsert: true },
    )
  }

  private emitEvent(record: EmittedUtterance): void {
    const event: UtteranceEvent = {
      type: 'utterance',
      utterance_id: record.utterance_id,
      conversation_id: this.options.conversationId,
      person_id: record.person_id,
      identity_confidence: record.identity_confidence,
      voiceprint_id: record.voiceprint_id,
      text: record.text,
      start_ms: record.start_ms,
      end_ms: record.end_ms,
      is_final: record.is_final,
    }
    this.options.bus.emit(event)
  }

  /**
   * Ask identity about clusters that have accumulated enough new speech to be
   * worth asking about.
   *
   * Every unresolved cluster over the floor used to be re-embedded on every
   * 100 ms frame, so a ten-minute conversation with one stubbornly unnamed
   * voice re-encoded a growing buffer six thousand times — quadratic in session
   * length, on a single-threaded CPU sidecar shared with clustering. Attempts
   * now happen on a ladder: at the embedding floor, again where accuracy
   * crosses into provisional, again where it is settled, and thereafter only
   * once per confirmed-length stretch of additional speech.
   */
  private async maybeAttribute(): Promise<void> {
    if (!this.options.identity) return
    const { embedMinMs, provisionalSpeechMs, confirmedSpeechMs } = this.config
    this.announcePending()
    for (const speaker of this.buffer.speakersOverFloor(embedMinMs)) {
      // A confirmed identity is done. A provisional one is a guess that more
      // speech can upgrade, so it stays on the ladder.
      if (
        speaker === UNKNOWN_SPEAKER ||
        this.resolving.has(speaker) ||
        this.resolved.get(speaker)?.identity_confidence === 'confirmed'
      ) {
        continue
      }
      const speechMs = this.buffer.speechMsFor(speaker)
      if (speechMs < (this.nextAttemptMs.get(speaker) ?? embedMinMs)) continue
      this.nextAttemptMs.set(
        speaker,
        speechMs < provisionalSpeechMs
          ? provisionalSpeechMs
          : speechMs < confirmedSpeechMs
            ? confirmedSpeechMs
            : speechMs + confirmedSpeechMs,
      )
      this.resolving.add(speaker)
      try {
        const result = await this.attribute(speaker, this.buffer.audioFor(speaker))
        if (result) await this.reEmitFor(speaker)
      } finally {
        this.resolving.delete(speaker)
      }
    }
  }

  /** Embed pooled speech and ask identity who it is. Records the outcome. */
  private async attribute(speaker: string, speech: Float32Array): Promise<boolean> {
    if (!this.options.identity) return false
    try {
      const embedding = await embedPcm(speech)
      this.recordEmbedding(embedding.vector)
      const result = await this.options.identity.attributeSpeaker({
        embedding: embedding.vector,
        session_mean: this.sessionMean,
        session_speaker: speaker,
        duration_ms: embedding.duration_ms,
        conversation_id: this.options.conversationId,
        utterance_ids: this.utteranceIdsFor(speaker),
      })
      this.recordSuccess('identity')
      return this.applyResult(speaker, result)
    } catch (error) {
      // Attribution is retryable; the transcript must not stall for it. But a
      // persistently failing service is now visible rather than merely quiet.
      this.recordFailure('identity', error, `attribution for ${speaker}`)
    }
    return false
  }

  /**
   * Record what identity concluded. A provisional match is deliberately not
   * treated as settled: the cluster stays on the attempt ladder so that more
   * pooled speech can upgrade it to confirmed, which is what lets the identity
   * lane reinforce the person's voiceprints for the next conversation.
   */
  private applyResult(speaker: string, result: AttributionResult): boolean {
    if (result.status === 'pending') {
      this.pendingReason.set(speaker, result.reason === 'below_floor' ? 'gathering' : result.reason)
      return false
    }
    this.pendingReason.delete(speaker)
    this.resolved.set(speaker, {
      person_id: result.person_id,
      voiceprint_id: result.voiceprint_id,
      identity_confidence: result.identity_confidence,
    })
    return true
  }

  /**
   * Pool each live cluster's audio and embed it, for consolidation to compare.
   *
   * Raw prints, not centred ones. Measured on the 48-minute recording, centring
   * the pooled labels produced 17 groups where raw cosine produced 7: with a
   * handful of people the session mean is dominated by those people rather than
   * by the room, and subtracting it pushes their prints apart.
   */
  private async poolPrints(
    candidates: { key: string; spans: { start_ms: number; end_ms: number }[] }[],
  ): Promise<{ raw: Map<string, number[]>; durations: Map<string, number> }> {
    const embeddings = new Map<string, number[]>()
    const durations = new Map<string, number>()
    for (const { key, spans } of candidates) {
      const speechMs = spans.reduce((total, span) => total + (span.end_ms - span.start_ms), 0)
      if (speechMs < this.config.embedMinMs) continue
      const audio = this.buffer.audioForSpans(spans)
      if (audio.length === 0) continue
      try {
        const embedding = await embedPcm(audio)
        this.recordEmbedding(embedding.vector)
        embeddings.set(key, embedding.vector)
        durations.set(key, speechMs)
      } catch (error) {
        this.recordFailure('embedding', error, `pooled embed for ${key}`)
      }
    }
    return { raw: embeddings, durations }
  }

  /**
   * Put the live pass's over-splits back together, once.
   *
   * The runaway-cluster signal the failure note on nearestCluster in
   * cluster-pass.ts asked for is computed from these same totals, in
   * applyCorrection, and reported on FinalPassReport.
   *
   * Clustering during the conversation is deliberately trigger-happy: it works
   * from 1.5-second windows, where telling two voices apart is barely better
   * than a guess, and the safe error there is to split. Driven through the real
   * capture path that produced thirteen clusters for three people. At the end
   * the same speakers can be compared properly — whole pooled minutes, raw
   * cosine — which is the comparison that was measured to work, and the
   * over-splits collapse back. Clusters too short to embed are then attached to
   * whichever consolidated voice they sound like.
   */
  private async consolidateClusters(): Promise<void> {
    // A loop because the count is a measured knob, not because more is better;
    // see CONSOLIDATION_ROUNDS. Each round re-pools and recomputes the mean,
    // and it stops as soon as a round changes nothing.
    const rounds = Number(process.env.AUDIO_CONSOLIDATION_ROUNDS ?? CONSOLIDATION_ROUNDS)
    for (let round = 0; round < rounds; round += 1) {
      if (!(await this.consolidationRound())) return
    }
  }

  /** One merge pass. Returns whether anything moved. */
  private async consolidationRound(): Promise<boolean> {
    const all = this.buffer
      .speakersOverFloor(0)
      .filter((speaker) => speaker !== UNKNOWN_SPEAKER)
    const poolable = all.filter((speaker) => this.buffer.speechMsFor(speaker) >= this.config.embedMinMs)
    if (poolable.length < 2) return false

    const quality = await this.poolPrints(
      poolable.map((speaker) => ({ key: speaker, spans: this.buffer.spansFor(speaker) })),
    )
    const canonical = groupPooledLabels(quality.raw, quality.durations)
    const changed = new Set<string>()
    for (const [from, to] of canonical) {
      if (from === to) continue
      this.buffer.remapCluster(from, to)
      changed.add(from).add(to)
    }

    const survivors = [...new Set(canonical.values())]
    if (survivors.length === 0) {
      this.forget(changed)
      return changed.size > 0
    }
    for (const speaker of all) {
      if (canonical.has(speaker) || survivors.includes(speaker)) continue
      const audio = this.buffer.audioFor(speaker)
      if (audio.length === 0) continue
      try {
        const { vector } = await embedPcmForClustering(audio)
        this.recordEmbedding(vector)
        const scored = survivors
          .map((survivor) => ({ survivor, score: cosine(vector, quality.raw.get(survivor)!) }))
          .sort((a, b) => b.score - a.score)
        if (scored[0].score < WINDOW_LINK_MIN) continue
        if (scored.length > 1 && scored[0].score - scored[1].score < WINDOW_MARGIN) continue
        this.buffer.remapCluster(speaker, scored[0].survivor)
        changed.add(speaker).add(scored[0].survivor)
      } catch (error) {
        this.recordFailure('embedding', error, `consolidation embed for ${speaker}`)
      }
    }
    this.forget(changed)
    return changed.size > 0
  }

  /**
   * Discard what was concluded about clusters that consolidation re-labelled,
   * so they are asked about again. Only those: re-attributing a cluster nothing
   * happened to would double the identity calls of every session for nothing.
   */
  private forget(speakers: Set<string>): void {
    for (const speaker of speakers) {
      this.resolved.delete(speaker)
      this.nextAttemptMs.delete(speaker)
      this.pendingReason.delete(speaker)
      for (const key of this.announced) {
        if (key.startsWith(`${speaker}:`)) this.announced.delete(key)
      }
    }
  }

  /** Utterance ids whose span overlaps any of these spans. */
  private utterancesInSpans(spans: { start_ms: number; end_ms: number }[]): string[] {
    return [...this.emitted.values()]
      .filter((record) =>
        spans.some((span) => Math.min(span.end_ms, record.end_ms) > Math.max(span.start_ms, record.start_ms)),
      )
      .map((record) => record.utterance_id)
  }

  private utteranceIdsFor(speaker: string): string[] {
    return [...this.emitted.values()]
      .filter((record) => record.session_speaker === speaker)
      .map((record) => record.utterance_id)
  }

  private recordEmbedding(vector: number[]): void {
    if (!this.embeddingSum) this.embeddingSum = new Array(vector.length).fill(0)
    if (this.embeddingSum.length !== vector.length) return
    for (let i = 0; i < vector.length; i += 1) this.embeddingSum[i] += vector[i]
    this.embeddingCount += 1
  }

  private recordSuccess(subsystem: Subsystem): void {
    this.failures.delete(subsystem)
  }

  /**
   * Count a failure and, once they stop looking like bad luck, say so on the
   * bus. Silence and a dead sidecar produce identical transcripts otherwise.
   */
  private recordFailure(subsystem: Subsystem, error: unknown, context: string): void {
    const message = error instanceof Error ? error.message : String(error)
    const state = this.failures.get(subsystem) ?? { count: 0, message, announced: false }
    state.count += 1
    state.message = `${context}: ${message}`
    this.failures.set(subsystem, state)
    console.error(`${this.conversationId} ${state.message}`)
    if (state.count < FAILURES_BEFORE_ANNOUNCING || state.announced) return
    state.announced = true
    const event: AmeliaStepEvent = {
      type: 'amelia_step',
      request_id: this.conversationId,
      step: 'error',
      message:
        `Speaker identification is unavailable — ${state.count} consecutive ${subsystem} ` +
        `failures. Last error: ${message}. ` +
        'Transcription continues; nobody will be named until this recovers.',
    }
    this.options.bus.emit(event)
  }

  /**
   * Tell the client which speakers we are still working on, so their lines read
   * "Attributing…" rather than "Unknown speaker". Attribution needs pooled
   * speech, and the transcript should not pretend that waiting means failure.
   * Re-emitted whenever the reason changes, and superseded by the IdentityEvent.
   */
  private announcePending(): void {
    const pending = new Map<string, string[]>()
    for (const record of this.emitted.values()) {
      const speaker = record.session_speaker
      if (speaker === UNKNOWN_SPEAKER || record.person_id || this.resolved.has(speaker)) continue
      const ids = pending.get(speaker) ?? []
      ids.push(record.utterance_id)
      pending.set(speaker, ids)
    }
    for (const [speaker, utteranceIds] of pending) {
      const speechMs = this.buffer.speechMsFor(speaker)
      // Identity's own vocabulary when it has spoken; otherwise we are simply
      // still listening, which is not the same thing as having failed.
      const reason: SpeakerPendingEvent['reason'] =
        this.pendingReason.get(speaker) ??
        (speechMs < this.config.provisionalSpeechMs ? 'gathering' : 'no_match')
      const key = `${speaker}:${reason}`
      if (this.announced.has(key)) continue
      this.announced.add(key)
      const event: SpeakerPendingEvent = {
        type: 'speaker_pending',
        conversation_id: this.options.conversationId,
        session_speaker: speaker,
        utterance_ids: utteranceIds,
        speech_ms: speechMs,
        provisional_speech_ms: this.config.provisionalSpeechMs,
        reason,
      }
      this.options.bus.emit(event)
    }
  }

  private async reEmitFor(speaker: string): Promise<void> {
    const identity = this.resolved.get(speaker)
    if (!identity) return
    for (const record of this.emitted.values()) {
      if (record.session_speaker !== speaker) continue
      // The confidence has to be part of this comparison, not just the person.
      // A cluster that goes provisional -> confirmed keeps the same person_id,
      // and extraction refuses to file facts below 'confirmed' — so skipping
      // the re-emit here would mean a speaker whose identity settled late never
      // has a single fact recorded against them, silently and forever.
      if (
        record.person_id === identity.person_id &&
        record.identity_confidence === identity.identity_confidence
      ) {
        continue
      }
      record.person_id = identity.person_id
      record.identity_confidence = identity.identity_confidence
      record.voiceprint_id = identity.voiceprint_id
      if (record.is_final) await this.persist(record)
      this.emitEvent(record)
    }
  }

  /**
   * The final pass. Rebuild the transcript from the retained audio, with each
   * job given to the model that is actually good at it.
   *
   * whisper-1 transcribes the whole file and knows nothing about speakers.
   * pyannote diarizes the whole file and knows nothing about words. They are
   * joined at word level — see word-join.ts for why not at segment level — and
   * the result replaces the live pass's guesses under the same utterance ids,
   * so a user still reading the transcript watches it settle rather than
   * watching it reload.
   *
   * The text is replaced too, and that is a change. It used to be left alone on
   * the reasoning that better prose was not worth the risk of losing a line.
   * But the text the live path produces is not merely imperfectly spelled: on
   * seven-way crosstalk the diarizing model returns fragments — "but like",
   * "Yeah. That's", "No, alright," — because it is transcribing sixteen-minute
   * chunks of it. Whisper over the whole file is coherent, and the ids are
   * carried across by time overlap so a line revises rather than disappears.
   */
  async runFinalPass(): Promise<FinalPassReport> {
    const empty: FinalPassReport = { ran: false, labels: [], corrected: 0, segments: [] }
    if (!this.config.finalPassEnabled) return { ...empty, reason: 'AUDIO_FINAL_PASS is off' }
    const path = await this.recorder?.close().catch(() => null)
    if (!path) return { ...empty, reason: 'no retained audio for this session' }
    const retainedMs = this.recorder?.durationMs ?? 0
    const truncated = this.recorder?.isTruncated ?? false
    // Everything downstream is corrected against the retained file, so a
    // truncated file means a partly-corrected transcript. Carried explicitly
    // rather than inferred, because the live transcript still holds the whole
    // conversation and nothing else would give the discrepancy away.
    const base: FinalPassReport = {
      ...empty,
      retainedMs,
      truncated,
      uncoveredMs: truncated ? Math.max(0, this.buffer.elapsedMs - retainedMs) : 0,
    }
    if (truncated) {
      console.warn(
        `session audio was truncated at the ${this.config.retainMaxMs} ms retention cap; ` +
          `${Math.round((base.uncoveredMs ?? 0) / 1000)}s of this conversation will keep its ` +
          'live-pass speaker labels because the final pass never saw that audio',
      )
      // Said out loud, not just logged. A server log is not a user, and the
      // recordings long enough to hit the cap are the ones whose speaker labels
      // are worth the most. Emitted before the transcript is corrected rather
      // than after, because the fact is already known and the correction can
      // take minutes; a later ConversationEvent carrying a title is a revision
      // of this one, so a reducer must carry these fields forward the same way
      // it already carries title and ended_at.
      this.options.bus.emit({
        type: 'conversation',
        conversation_id: this.options.conversationId,
        audio_truncated: true,
        covered_to_ms: retainedMs,
      })
    }

    let lines: AttributedTurn[]
    let diarization: Awaited<ReturnType<typeof diarizeAudio>>
    try {
      const wav = await readFile(path)
      const transcript = await transcribeWithTimings(wav, {
        vocabulary: this.config.vocabularyEnabled ? await this.options.vocabulary?.() : undefined,
      })
      if (transcript.words.length === 0) {
        return { ...base, ran: true, reason: 'transcription returned no words' }
      }
      diarization = await diarizeAudio(readWav(wav).samples)
      if (diarization.turns.length === 0) {
        return { ...base, ran: true, reason: 'diarization heard nobody' }
      }
      const turns = await this.correctBySentence(readWav(wav).samples, transcript, diarization.turns)
      lines = joinWordsToSpeakers(transcript.words, turns, { segments: transcript.segments })
      this.recordSuccess('diarization')
    } catch (error) {
      this.recordFailure('diarization', error, 'final transcription and diarization pass')
      return { ...base, reason: this.failures.get('diarization')?.message ?? 'final pass failed' }
    }
    return this.applyCorrection(lines, diarization, base)
  }

  /**
   * Re-attribute whole sentences against pooled voice models.
   *
   * The diarizer decides where the boundaries are and who is talking, and it is
   * better at the first than the second: a sentence is about four times purer
   * than a turn, and comparing a clip against a pooled model of a voice beats
   * comparing it against a neighbouring turn. So the boundaries are kept and
   * the labels are asked again, sentence by sentence. See sentence-pass.ts for
   * what this is measured to do and what it costs.
   *
   * Failure here returns the turns untouched. This is a correction on top of a
   * usable answer, and a correction that can make things worse is not one.
   */
  private async correctBySentence(
    samples: Float32Array,
    transcript: { words: TimedWord[]; segments: { start_ms: number; end_ms: number }[] },
    turns: SpeakerTurn[],
  ): Promise<SpeakerTurn[]> {
    try {
      // whisper's own segments are the sentence units wherever it gives them,
      // which is what the evaluation measured. The punctuation-walked fallback
      // covers transcripts that arrive as bare timed words, and drops the
      // trailing unterminated run: that is not a sentence, and with punctuation
      // missing altogether it would be the entire recording.
      const sentences =
        transcript.segments.length > 0
          ? transcript.segments
          : sentencesFromWords(transcript.words).filter((sentence) => sentence.terminated)
      const slice = (start_ms: number, end_ms: number) =>
        samples.subarray(
          Math.max(0, Math.round((start_ms / 1000) * SAMPLE_RATE)),
          Math.min(samples.length, Math.round((end_ms / 1000) * SAMPLE_RATE)),
        )

      const pools = new Map<string, number[]>()
      for (const [speaker, stretches] of poolableStretches(turns)) {
        const spans = stretchesWithinBudget(stretches)
        const pooled = concatSamples(spans.map((span) => slice(span.start_ms, span.end_ms)))
        // The sidecar rejects anything under its own three-second floor, and a
        // speaker with less clean speech than that has no pool worth matching
        // against; their turns simply keep the diarizer's answer.
        if (pooled.length < 3 * SAMPLE_RATE) continue
        const { vector } = await embedPcm(pooled)
        this.recordEmbedding(vector)
        pools.set(speaker, vector)
      }
      if (pools.size < 2) return turns

      const attributed: SpeakerTurn[] = []
      for (const sentence of sentences) {
        if (sentence.end_ms - sentence.start_ms < SENTENCE_TRUST_MS) continue
        const clip = slice(sentence.start_ms, sentence.end_ms)
        if (clip.length === 0) continue
        // The short endpoint, deliberately. Its warning is against naming a
        // PERSON from a brief clip; this asks the much easier question it is
        // documented as being good at — which of these voices, in this room, on
        // this microphone — and answers it against pooled models, not clips.
        const { vector } = await embedPcmForClustering(clip)
        const speaker = bestPool(vector, pools)
        if (speaker) attributed.push({ start_ms: sentence.start_ms, end_ms: sentence.end_ms, speaker })
      }
      return rewriteTurns(turns, attributed)
    } catch (error) {
      this.recordFailure('embedding', error, 'sentence-level correction')
      return turns
    }
  }

  /**
   * Ask identity who each diarized speaker is, then rewrite the transcript.
   *
   * There is no gate here any more. The old pass scored its own segmentation
   * against the live clustering and declined when it did not win, because the
   * reference it used was nondeterministic — the diarizing model disagreed with
   * its own previous run by about 29% and sometimes put two people inside one
   * label, so a bad run had to be caught at runtime. pyannote does not have
   * that failure mode on the evidence available: it is deterministic, and
   * against landmarks whose speaker the words themselves settle it splits
   * nobody on either recording, where the live path split the owner's own
   * voice across two speakers for a whole evening. A gate whose reference is
   * the thing being replaced can only reject the better answer.
   */
  private async applyCorrection(
    lines: AttributedTurn[],
    diarization: { turns: SpeakerTurn[]; speakers: string[]; overlapMs: number; elapsedMs: number },
    empty: FinalPassReport,
  ): Promise<FinalPassReport> {
    const liveClusters = this.buffer
      .speakersOverFloor(this.config.embedMinMs)
      .filter((speaker) => speaker !== UNKNOWN_SPEAKER)
    const liveSpeech = liveClusters.map((speaker) => this.buffer.speechMsFor(speaker))
    const clusteredMs = liveSpeech.reduce((total, ms) => total + ms, 0)
    const diagnostics = {
      largestLiveClusterShare: clusteredMs === 0 ? 0 : Math.max(0, ...liveSpeech) / clusteredMs,
      poolableLiveClusters: liveClusters.length,
    }

    await this.identifyDiarizedSpeakers(diarization.turns)

    // Nothing past the retained audio was ever diarized, so the live pass's
    // labels are the only ones that stretch has. Leave those lines alone
    // instead of letting the rebuilt transcript imply a coverage it never had.
    const coveredToMs = empty.truncated ? (empty.retainedMs ?? 0) : Number.POSITIVE_INFINITY
    const carried = [...this.emitted.values()]
      .filter((record) => record.start_ms >= coveredToMs)
      .sort((a, b) => a.start_ms - b.start_ms)
    const replaceable = [...this.emitted.values()]
      .filter((record) => record.start_ms < coveredToMs)
      .sort((a, b) => a.start_ms - b.start_ms)

    const rebuilt = this.reidentifyLines(
      lines.filter((line) => line.start_ms < coveredToMs),
      replaceable,
    )

    // Looked up by id, not by start_ms: the ids were carried across by time
    // overlap precisely because the boundaries moved, so keying the comparison
    // on the boundary would report every line as changed.
    const before = new Map(replaceable.map((record) => [record.utterance_id, record]))
    let corrected = 0
    for (const record of rebuilt) {
      if (unchanged(before.get(record.utterance_id), record)) continue
      corrected += 1
      await this.persist(record)
      this.emitEvent(record)
    }

    // A live line the rebuilt transcript did not claim is not a line any more.
    // Saying so is the whole reason UtteranceEvent carries `superseded`: the
    // alternative is a stale row sitting under a corrected transcript, holding
    // text nobody said and a name nobody agreed to, with no way for a client to
    // know it should go.
    const kept = new Set(rebuilt.map((record) => record.utterance_id))
    const dropped = replaceable.filter((record) => !kept.has(record.utterance_id))
    for (const record of dropped) await this.supersede(record)

    this.emitted.clear()
    for (const record of [...carried, ...rebuilt]) this.emitted.set(record.start_ms, record)

    const totalWords = lines.reduce((total, line) => total + line.words.length, 0)
    const attributedWords = lines
      .filter((line) => line.speaker)
      .reduce((total, line) => total + line.words.length, 0)
    return {
      ...empty,
      ...diagnostics,
      ran: true,
      labels: diarization.speakers,
      corrected,
      split: Math.max(0, rebuilt.length - replaceable.length),
      superseded: dropped.length,
      segments: diarization.turns,
      attributedWords,
      totalWords,
      overlapMs: diarization.overlapMs,
      diarizeMs: diarization.elapsedMs,
    }
  }

  /**
   * Pool each diarized speaker's exclusive speech and ask identity who it is.
   *
   * Exclusive, not everything they hold: audio where two people talk at once
   * embeds as neither of them, and this pipeline's previous failure was built
   * entirely out of blends. See overlap.ts.
   *
   * Every speaker is asked about in one call where the identity service
   * supports it, because assigning the clusters of one session together is the
   * only thing that stops two distinct voices in a room being handed the same
   * person.
   */
  private async identifyDiarizedSpeakers(turns: SpeakerTurn[]): Promise<void> {
    const identity = this.options.identity
    if (!identity) return
    const clean = exclusiveTurns(turns)
    const speechMs = speechMsBySpeaker(clean)

    const clusters: (Omit<AttributionInput, 'conversation_id'> & { session_speaker: string })[] = []
    for (const speaker of [...new Set(turns.map((turn) => turn.speaker))]) {
      // Below the floor the print is not stable enough to name anybody by, and
      // identity refuses it anyway. Asking is a wasted forward pass.
      if ((speechMs.get(speaker) ?? 0) < this.config.embedMinMs) continue
      const spans = clean.filter((turn) => turn.speaker === speaker)
      const audio = this.buffer.audioForSpans(spans)
      if (audio.length === 0) continue
      try {
        const embedding = await embedPcm(audio)
        this.recordEmbedding(embedding.vector)
        clusters.push({
          embedding: embedding.vector,
          session_mean: null,
          session_speaker: diarizedSpeaker(speaker),
          duration_ms: embedding.duration_ms,
          utterance_ids: this.utterancesInSpans(spans),
        })
      } catch (error) {
        this.recordFailure('embedding', error, `final pass embed for ${speaker}`)
      }
    }
    if (clusters.length === 0) return

    // The mean that matters here is the mean of the pooled speaker embeddings,
    // not the running mean of every embedding this session took. The running
    // mean is dominated by hundreds of sub-second clustering embeds and does
    // not remove the channel: subtracting it left every pair of speakers above
    // the link threshold and collapsed three people into one.
    const mean = poolMean(clusters.map((cluster) => cluster.embedding))
    for (const cluster of clusters) cluster.session_mean = mean
    try {
      if (identity.attributeSession) {
        const results = await identity.attributeSession({
          conversation_id: this.options.conversationId,
          clusters,
        })
        for (const [speaker, result] of Object.entries(results)) this.applyResult(speaker, result)
      } else {
        for (const cluster of clusters) {
          this.applyResult(
            cluster.session_speaker,
            await identity.attributeSpeaker({ ...cluster, conversation_id: this.options.conversationId }),
          )
        }
      }
      this.recordSuccess('identity')
    } catch (error) {
      this.recordFailure('identity', error, 'final pass attribution')
    }
  }

  /**
   * Carry the live transcript's utterance ids onto the rebuilt lines.
   *
   * By time overlap, and each old id claimed at most once. Re-emitting under
   * the same id is a revision, so a line the user is looking at gets its words
   * and its speaker corrected in place; a line with no counterpart is new, and
   * an old line nothing claimed is superseded by the caller. Keying on start_ms
   * instead would mint a fresh id for every line whose boundary moved, which is
   * all of them — whisper and the live VAD do not draw the same edges.
   */
  private reidentifyLines(
    lines: AttributedTurn[],
    replaceable: EmittedUtterance[],
  ): EmittedUtterance[] {
    const unclaimed = new Set(replaceable)
    return lines.map((line) => {
      let best: { record: EmittedUtterance; overlap: number } | undefined
      for (const record of unclaimed) {
        const overlap = Math.min(record.end_ms, line.end_ms) - Math.max(record.start_ms, line.start_ms)
        if (overlap <= 0) continue
        if (!best || overlap > best.overlap) best = { record, overlap }
      }
      if (best) unclaimed.delete(best.record)

      const sessionSpeaker = line.speaker ? diarizedSpeaker(line.speaker) : UNKNOWN_SPEAKER
      const identity = this.resolved.get(sessionSpeaker)
      // A line spoken across somebody else has no single certain speaker, so it
      // carries the name without the confidence that lets extraction file facts
      // against it. Hedging is cheap; filing one person's sentence under
      // another person's name is not.
      const confidence =
        line.overlapped && identity?.identity_confidence === 'confirmed'
          ? 'provisional'
          : identity?.identity_confidence
      return {
        utterance_id: best?.record.utterance_id ?? crypto.randomUUID(),
        session_speaker: sessionSpeaker,
        person_id: identity?.person_id,
        identity_confidence: confidence,
        voiceprint_id: identity?.voiceprint_id,
        text: line.text,
        start_ms: line.start_ms,
        end_ms: line.end_ms,
        is_final: true,
      }
    })
  }

  /** Take a line out of the transcript, in the store and on every client. */
  private async supersede(record: EmittedUtterance): Promise<void> {
    await this.options.utterances?.deleteOne({ _id: record.utterance_id })
    this.options.bus.emit({
      type: 'utterance',
      utterance_id: record.utterance_id,
      conversation_id: this.options.conversationId,
      text: '',
      start_ms: record.start_ms,
      end_ms: record.end_ms,
      is_final: true,
      superseded: true,
    })
  }
}

/** Cluster ids from the final pass, namespaced away from live cluster ids. */
function diarizedSpeaker(label: string): string {
  return `diarized-${label}`
}

function unchanged(previous: EmittedUtterance | undefined, next: EmittedUtterance): boolean {
  return (
    previous !== undefined &&
    previous.text === next.text &&
    previous.start_ms === next.start_ms &&
    previous.end_ms === next.end_ms &&
    previous.session_speaker === next.session_speaker &&
    previous.person_id === next.person_id &&
    previous.identity_confidence === next.identity_confidence &&
    previous.is_final === next.is_final
  )
}

/**
 * Group pooled prints of one recording into voices.
 *
 * Thin wrapper so the live consolidation pass and the final pass group by the
 * same rule; see agglomerate.ts for the measurement behind the threshold and
 * for why average linkage rather than the single linkage this used to use.
 */
function groupPooledLabels(
  raw: Map<string, number[]>,
  durations: Map<string, number>,
): Map<string, string> {
  const prints = [...raw].map(([label, vector]) => ({
    label,
    vector,
    pooledMs: durations.get(label) ?? 0,
    speechMs: durations.get(label) ?? 0,
  }))
  const survivor = new Map<string, string>()
  for (const group of agglomerateByAverageLinkage(prints)) {
    for (const member of group.members) survivor.set(member, group.representative)
  }
  return survivor
}

/** Element-wise mean. See the note at its call site on which mean this must be. */
function poolMean(embeddings: number[][]): number[] {
  return embeddings[0].map(
    (_, i) => embeddings.reduce((total, embedding) => total + embedding[i], 0) / embeddings.length,
  )
}
