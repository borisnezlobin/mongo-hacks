/**
 * One live audio session: PCM in, attributed utterances out.
 *
 * Owns a StreamBuffer, feeds providers, periodically finalizes utterances
 * behind the live edge, persists them when Mongo is configured, and triggers
 * voiceprint attribution once a session speaker crosses the embedding floor.
 * The same object serves the live WebSocket and the WAV replay path.
 */

import type { Collection } from 'mongodb'
import {
  EMBED_MIN_MS,
  OWNER_ID,
  type SpeakerPendingEvent,
  type Utterance,
  type UtteranceEvent,
} from '../../shared/contracts'
import type { AmeliaBus } from '../lib/bus'
import { embedPcm, embedPcmForClustering } from './embed-client'
import { MIN_EMBED_MS, SpeakerClusterer } from './speaker-clusterer'
import { StreamBuffer, UNKNOWN_SPEAKER } from './stream-buffer'
import type { PendingUtterance, StreamProvider } from './types'

/**
 * How far behind the live edge an utterance must be to count as final.
 *
 * This is a correctness margin, not a latency budget: it only has to outlast
 * the provider's own revisions. It used to be 1200 ms, which put more than a
 * second of dead air in front of every line on screen for no benefit.
 */
const HOLDBACK_MS = 300

/**
 * `??` rescues an absent variable but not an empty one, and a copied
 * .env.example hands us `''` for anything documented as "leave blank for the
 * default" — which Number() turns into a silent 0: a retry throttle that never
 * throttles, or an attempt budget that is spent before the first attempt.
 * Anything that is not a finite number means "use the default".
 */
function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

export interface AttributionService {
  attributeSpeaker(input: {
    embedding: number[]
    duration_ms: number
    conversation_id: string
    utterance_ids: string[]
    final?: boolean
  }): Promise<
    | { status: 'pending'; reason: string }
    | { status: 'matched'; person_id: string; voiceprint_id: string; confidence: number }
    | { status: 'created'; person_id: string; voiceprint_id: string }
  >
}

export interface SessionOptions {
  conversationId: string
  bus: AmeliaBus
  provider: StreamProvider
  identity: AttributionService | null
  utterances: Collection<Utterance> | null
  now?: () => Date
}

interface EmittedUtterance {
  utterance_id: string
  session_speaker: string
  person_id?: string
  voiceprint_id?: string
  text: string
  start_ms: number
  end_ms: number
  is_final: boolean
}

export class AudioSession {
  private readonly buffer: StreamBuffer
  /** Keyed by start_ms — the stable identity of an utterance across revisions. */
  private readonly emitted = new Map<number, EmittedUtterance>()
  /** Session speakers resolved to people, and those currently being resolved. */
  private readonly resolved = new Map<string, { person_id: string; voiceprint_id: string }>()
  private readonly resolving = new Set<string>()
  /** Pooled speech ms at the last ambiguous verdict, and how many we have had. */
  private readonly ambiguousAt = new Map<string, number>()
  private readonly ambiguousAttempts = new Map<string, number>()
  private readonly now: () => Date
  /** Decides which provider turns are the same voice. See speaker-clusterer.ts. */
  private readonly clusterer = new SpeakerClusterer()
  private clustering = false
  /** Provider turns already handed to the clusterer. */
  private readonly submitted = new Set<string>()
  /** Clusters we have already told the client are being attributed. */
  private readonly announced = new Set<string>()

  constructor(private readonly options: SessionOptions) {
    this.buffer = new StreamBuffer(options.conversationId)
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

  /** Feed one chunk of float32 PCM. Drives everything else. */
  async pushAudio(pcm: Float32Array): Promise<void> {
    const positionMs = this.buffer.pushAudio(pcm)
    this.options.provider.pushAudio(pcm, positionMs)
    await this.clusterTurns()
    await this.finalize(positionMs - HOLDBACK_MS)
    await this.maybeAttribute()
  }

  /** Ask the provider to flush its trailing turn, then finalize the result. */
  async end(): Promise<void> {
    let providerError: unknown
    try {
      await this.options.provider.close()
    } catch (error) {
      providerError = error
    }
    await this.clusterTurns()
    // Nothing more is coming, so held-back turns take their best guess now
    // rather than staying nameless.
    for (const assignment of this.clusterer.flush()) {
      this.buffer.setSpeakerAlias(assignment.label, assignment.clusterId)
    }
    await this.finalize(Number.POSITIVE_INFINITY)
    await this.maybeAttribute(true)
    if (providerError) throw providerError
  }

  /**
   * Fold newly-arrived provider turns into speaker clusters.
   *
   * Without a diarising model every VAD turn arrives under its own label, so
   * this is where "who is talking" is actually decided. Turns long enough to
   * embed are placed by voice; the rest are placed by adjacency inside the
   * clusterer. Failures are swallowed: an unclustered turn keeps its provider
   * label and simply stays unattributed, which is what used to happen to
   * everything.
   */
  private async clusterTurns(): Promise<void> {
    if (this.clustering) return
    this.clustering = true
    try {
      for (const turn of this.buffer.unaliasedTurns()) {
        // A turn too short to embed stays unaliased while the clusterer holds
        // it waiting for a neighbour, so track submissions separately or we
        // would hand it over again on every chunk.
        if (this.submitted.has(turn.speaker)) continue
        this.submitted.add(turn.speaker)
        const durationMs = turn.end_ms - turn.start_ms
        let embedding: number[] | null = null
        const audio = this.buffer.audioForTurn(turn.speaker)
        if (durationMs >= MIN_EMBED_MS && audio.length > 0) {
          try {
            embedding = (await embedPcmForClustering(audio)).vector
          } catch (error) {
            console.error(`clustering embed failed for ${turn.speaker}`, error)
            this.submitted.delete(turn.speaker)
            continue
          }
        }
        for (const assignment of this.clusterer.add(
          { label: turn.speaker, start_ms: turn.start_ms, end_ms: turn.end_ms },
          embedding,
        )) {
          this.buffer.setSpeakerAlias(assignment.label, assignment.clusterId)
        }
      }
    } finally {
      this.clustering = false
    }
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
   */
  private async finalize(cutoffMs: number): Promise<void> {
    for (const pending of this.buffer.utterances()) {
      if (pending.session_speaker === UNKNOWN_SPEAKER) continue
      const isFinal = pending.end_ms <= cutoffMs
      const existing = this.emitted.get(pending.start_ms)
      if (
        existing &&
        existing.text === pending.text &&
        existing.session_speaker === pending.session_speaker &&
        existing.is_final === isFinal
      ) {
        continue
      }
      await this.emitUtterance(pending, isFinal, existing?.utterance_id)
    }
  }

  private async emitUtterance(
    pending: PendingUtterance,
    isFinal: boolean,
    reuseId?: string,
  ): Promise<void> {
    const identity = this.resolved.get(pending.session_speaker)
    const record: EmittedUtterance = {
      utterance_id: reuseId ?? crypto.randomUUID(),
      session_speaker: pending.session_speaker,
      person_id: identity?.person_id,
      voiceprint_id: identity?.voiceprint_id,
      text: pending.text,
      start_ms: pending.start_ms,
      end_ms: pending.end_ms,
      is_final: isFinal,
    }
    this.emitted.set(pending.start_ms, record)
    // Drafts are not written to the database: they are superseded within a
    // second or two, and persisting each keystroke of a sentence would triple
    // the write volume for nothing.
    if (isFinal) await this.persist(record)
    this.emitEvent(record)
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
      voiceprint_id: record.voiceprint_id,
      text: record.text,
      start_ms: record.start_ms,
      end_ms: record.end_ms,
      is_final: record.is_final,
    }
    this.options.bus.emit(event)
  }

  /**
   * Once a session speaker crosses the embedding floor and is not yet
   * resolved, embed their concatenated speech and ask identity to match or
   * create. On resolution, re-emit that speaker's utterances with the person
   * attached — same utterance_id, so clients replace in place.
   */
  private async maybeAttribute(sessionEnding = false): Promise<void> {
    if (!this.options.identity) return
    const floorMs = envNumber('EMBED_MIN_MS', EMBED_MIN_MS)
    this.announcePending(floorMs)
    for (const speaker of this.buffer.speakersOverFloor(floorMs)) {
      if (speaker === UNKNOWN_SPEAKER || this.resolved.has(speaker) || this.resolving.has(speaker)) {
        continue
      }
      const attempts = this.ambiguousAttempts.get(speaker) ?? 0
      const lastAmbiguousAt = this.ambiguousAt.get(speaker)
      const outOfRetries = attempts >= envNumber('ATTRIBUTION_MAX_ATTEMPTS', 3)
      const isFinalAttempt = sessionEnding || outOfRetries
      if (lastAmbiguousAt !== undefined && !isFinalAttempt) {
        // The embedding is a pure function of the pooled clip, so retrying
        // without new speech is guaranteed to reach the same verdict — and
        // maybeAttribute runs on every 100 ms frame, on the same promise chain
        // that carries audio ingest.
        const growthMs = envNumber('ATTRIBUTION_RETRY_SPEECH_MS', floorMs)
        if (this.buffer.speechMsFor(speaker) - lastAmbiguousAt < growthMs) continue
      }
      this.resolving.add(speaker)
      try {
        const speech = this.buffer.audioFor(speaker)
        const embedding = await embedPcm(speech)
        const utteranceIds = [...this.emitted.values()]
          .filter((u) => u.session_speaker === speaker)
          .map((u) => u.utterance_id)
        const result = await this.options.identity.attributeSpeaker({
          embedding: embedding.vector,
          duration_ms: embedding.duration_ms,
          conversation_id: this.options.conversationId,
          utterance_ids: utteranceIds,
          ...(isFinalAttempt ? { final: true } : {}),
        })
        if (result.status === 'matched' || result.status === 'created') {
          this.ambiguousAt.delete(speaker)
          this.ambiguousAttempts.delete(speaker)
          this.resolved.set(speaker, {
            person_id: result.person_id,
            voiceprint_id: result.voiceprint_id,
          })
          await this.reEmitFor(speaker)
        } else if (result.reason === 'ambiguous') {
          this.ambiguousAt.set(speaker, this.buffer.speechMsFor(speaker))
          this.ambiguousAttempts.set(speaker, attempts + 1)
        }
      } catch (error) {
        // Attribution is retryable on the next chunk; the transcript must not stall.
        console.error(`attribution failed for ${speaker}`, error)
      } finally {
        this.resolving.delete(speaker)
      }
    }
  }

  /**
   * Tell the client which speakers we are still working on, so their lines read
   * "Attributing…" rather than "Unknown speaker". Attribution can take a few
   * seconds of pooled speech; the transcript should not pretend that means we
   * failed. Emitted once per cluster, and superseded by the IdentityEvent.
   */
  private announcePending(floorMs: number): void {
    const pending = new Map<string, string[]>()
    for (const record of this.emitted.values()) {
      const speaker = record.session_speaker
      if (speaker === UNKNOWN_SPEAKER || record.person_id || this.resolved.has(speaker)) continue
      const ids = pending.get(speaker) ?? []
      ids.push(record.utterance_id)
      pending.set(speaker, ids)
    }
    for (const [speaker, utteranceIds] of pending) {
      if (this.announced.has(speaker)) continue
      this.announced.add(speaker)
      const event: SpeakerPendingEvent = {
        type: 'speaker_pending',
        conversation_id: this.options.conversationId,
        session_speaker: speaker,
        utterance_ids: utteranceIds,
        speech_ms: this.buffer.speechMsFor(speaker),
        embed_min_ms: floorMs,
      }
      this.options.bus.emit(event)
    }
  }

  private async reEmitFor(speaker: string): Promise<void> {
    const identity = this.resolved.get(speaker)
    if (!identity) return
    for (const record of this.emitted.values()) {
      if (record.session_speaker !== speaker || record.person_id === identity.person_id) continue
      record.person_id = identity.person_id
      record.voiceprint_id = identity.voiceprint_id
      await this.persist(record)
      this.emitEvent(record)
    }
  }
}
