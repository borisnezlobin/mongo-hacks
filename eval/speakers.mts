/**
 * Runs a real recording through the real pipeline and prints numbers.
 *
 * `bun run eval:speakers`
 *
 * The thresholds in shared/contracts.ts are properties of a microphone and a
 * room, not of the code, so the only way to know whether a change helped is to
 * re-measure. This drives fixtures/real/dorm-9pm.wav — three people in a dorm at
 * nine at night, phone flat on a desk — through AudioSession with the live
 * ECAPA sidecar, and scores the result against the ground truth for that
 * recording -- Joshua, Boris and Tarun -- which lives in eval/ground-truth.ts.
 *
 * Scoring is eval/scoring.ts, shared with `bun run eval:diarization`, so the
 * headline here is the same `unexplained speech` measured the same way: wrong
 * person plus no answer, over all reference speech. What this script adds on
 * top of that is the thing only a live run can measure -- how long each person
 * spoke before the pipeline had a name for them.
 *
 * Flags:
 *   --provider=whisper|live   offline word timings, or OpenAI Realtime (default)
 *
 * `live` is the default because it is the only configuration the phone
 * actually runs. `whisper` replays clean offline word timings and behaves
 * completely differently — it is useful for iterating on the clusterer without
 * paying for a stream, and misleading if quoted as a production number.
 *   --no-final                skip the batch diarization pass (saves ~60 s)
 *   --speed=N                 push audio N times faster than realtime (default 8).
 *                             Pacing matters: the worker behind pushAudio is
 *                             deliberately decoupled, so shoving three minutes
 *                             of audio in at 40x measures the sidecar's queue
 *                             rather than the latency a person would feel.
 *                             --speed=1 is the honest number and takes 3 min.
 */

import { readFileSync } from 'node:fs'
import { hasRealFixture, missingFixtureNotice, readRealFixture, realFixturePath } from '../fixtures/real-audio'
import { ninePmReference } from './ground-truth'
import {
  collarSensitivity,
  formatScore,
  percent,
  score,
  type Reference,
  type Score,
  type Span,
  overlapMs,
} from './scoring'
import { AmeliaBus } from '../server/lib/bus'
import { audioConfig, configNotes, readAudioConfig, resetAudioConfig } from '../server/audio/config'
import { OpenAIRealtimeProvider } from '../server/audio/openai-realtime-provider'
import { AudioSession, type AttributionService } from '../server/audio/session'
import { readWav } from '../server/audio/wav'
import { readTimedTranscript, type WhisperResponse } from '../server/audio/whisper-client'
import { SAMPLE_RATE, type Segment, type StreamProvider, type Word } from '../server/audio/types'
import { ATTRIBUTION_MARGIN, ATTRIBUTION_THRESHOLD, AUDIO_FRAME_SAMPLES } from '../shared/contracts'
import type { AttributionResult } from '../server/identity'

/**
 * Ground truth for the three-minute recording.
 *
 * It lives in eval/ground-truth.ts, not here, because eval/diarization.mts
 * scores against the same three people and two copies of a reference is two
 * references. Loading it also brings the `excluded` and `truePeople` fields the
 * shared scorer needs.
 */
function reference() {
  const truth = ninePmReference()
  if (!truth) throw new Error(missingFixtureNotice('dorm-9pm.diarize.json'))
  return truth
}

function loadEnv(): void {
  try {
    process.loadEnvFile(new URL('../.env', import.meta.url).pathname)
  } catch {
    /* ambient environment */
  }
}

/**
 * Replays whisper-1's segments and word timings as a VAD-turn provider.
 *
 * This is what the realtime socket looks like from downstream: turn boundaries
 * with no speaker labels, words with timings. Using it keeps the harness
 * offline, deterministic and free, so a threshold change can be scored in
 * thirty seconds instead of three minutes of billed streaming.
 */
class WhisperReplayProvider implements StreamProvider {
  private segmentHandler: (segments: Segment[]) => void = () => {}
  private wordHandler: (words: Word[]) => void = () => {}
  private released = 0
  private readonly turns: { turn: string; start_ms: number; end_ms: number; words: Word[] }[]

  constructor() {
    const raw = readTimedTranscript(readRealFixture<WhisperResponse>('dorm-9pm.whisper.json'))
    const words = raw.words
    this.turns = raw.segments.map((segment, index) => {
      const { start_ms, end_ms } = segment
      const turn = `turn-${index}`
      const inside = words.filter((word) => (word.start_ms + word.end_ms) / 2 < end_ms && word.end_ms > start_ms)
      return {
        turn,
        start_ms,
        end_ms,
        words: (inside.length > 0
          ? inside
          : segment.text
              .trim()
              .split(/\s+/)
              .filter(Boolean)
              .map((text, index, all) => ({
                text,
                start_ms: start_ms + Math.round(((end_ms - start_ms) * index) / all.length),
                end_ms: start_ms + Math.round(((end_ms - start_ms) * (index + 1)) / all.length),
              }))
        ).map((word) => ({ ...word, turn })),
      }
    })
  }

  pushAudio(_pcm: Float32Array, positionMs: number): void {
    while (this.released < this.turns.length && this.turns[this.released].end_ms <= positionMs) {
      const turn = this.turns[this.released++]
      this.segmentHandler([{ speaker: turn.turn, start_ms: turn.start_ms, end_ms: turn.end_ms }])
      this.wordHandler(turn.words)
    }
  }

  onSegments(handler: (segments: Segment[]) => void): void {
    this.segmentHandler = handler
  }

  onWords(handler: (words: Word[]) => void): void {
    this.wordHandler = handler
  }

  async close(): Promise<void> {
    for (; this.released < this.turns.length; this.released += 1) {
      const turn = this.turns[this.released]
      this.segmentHandler([{ speaker: turn.turn, start_ms: turn.start_ms, end_ms: turn.end_ms }])
      this.wordHandler(turn.words)
    }
  }
}

/**
 * Stands in for the identity service without touching Atlas.
 *
 * It does the real arithmetic — subtract the session mean, cosine against each
 * known person, honour the measured threshold and margin — because a stub that
 * mints a new person per cluster cannot merge the diarizer's over-splits, and
 * merging them is exactly what the final pass is for. Scoring against such a
 * stub would blame the pipeline for the stub's own limitation.
 *
 * The bulk path assigns clusters to people one-to-one, greedily by best score,
 * which is what stops two voices in one room collapsing onto one person.
 */
function recordingIdentity(clock: () => number): AttributionService & {
  attributedAt: Map<string, number>
  peopleCount: number
  sawSessionMean: boolean
} {
  const attributedAt = new Map<string, number>()
  const people: { id: string; centroid: number[] }[] = []
  const state = { sawSessionMean: false }

  const centered = (embedding: number[], mean?: number[] | null): number[] => {
    const shifted = mean ? embedding.map((value, i) => value - mean[i]) : [...embedding]
    const norm = Math.sqrt(shifted.reduce((sum, value) => sum + value * value, 0)) || 1
    return shifted.map((value) => value / norm)
  }
  const cosine = (a: number[], b: number[]): number => a.reduce((sum, value, i) => sum + value * b[i], 0)

  const resolve = (
    vector: number[],
    utteranceIds: string[],
    forbidden: Set<string>,
  ): AttributionResult => {
    const scores = people
      .filter((person) => !forbidden.has(person.id))
      .map((person) => ({ person, score: cosine(vector, person.centroid) }))
      .sort((a, b) => b.score - a.score)
    const best = scores[0]
    const margin = best ? best.score - (scores[1]?.score ?? -1) : 0
    for (const utteranceId of utteranceIds) {
      if (!attributedAt.has(utteranceId)) attributedAt.set(utteranceId, clock())
    }
    if (best && best.score >= ATTRIBUTION_THRESHOLD && margin >= ATTRIBUTION_MARGIN) {
      return {
        status: 'matched',
        person_id: best.person.id,
        voiceprint_id: `vp-${best.person.id}`,
        confidence: best.score,
        identity_confidence: 'confirmed',
      }
    }
    const person = { id: `person-${people.length + 1}`, centroid: vector }
    people.push(person)
    return {
      status: 'created',
      person_id: person.id,
      voiceprint_id: `vp-${person.id}`,
      identity_confidence: 'confirmed',
    }
  }

  return {
    attributedAt,
    get peopleCount() {
      return people.length
    },
    get sawSessionMean() {
      return state.sawSessionMean
    },
    async attributeSpeaker(input) {
      if (input.session_mean?.length) state.sawSessionMean = true
      return resolve(centered(input.embedding, input.session_mean), input.utterance_ids, new Set())
    },
    async attributeSession({ clusters }) {
      const results: Record<string, AttributionResult> = {}
      const taken = new Set<string>()
      // Largest pools first: the most confident cluster claims its person
      // before a two-second fragment can take the same one.
      for (const cluster of [...clusters].sort((a, b) => b.duration_ms - a.duration_ms)) {
        if (cluster.session_mean?.length) state.sawSessionMean = true
        const result = resolve(
          centered(cluster.embedding, cluster.session_mean),
          cluster.utterance_ids,
          taken,
        )
        if (result.status !== 'pending') taken.add(result.person_id)
        results[cluster.session_speaker] = result
      }
      return results
    },
  }
}

/**
 * Prints one system's score, using the shared scorer.
 *
 * There used to be a second implementation of speaker error right here, and it
 * was the one that made an abstaining pass look ten points better than the pass
 * it was correcting. Two definitions of the same metric will always eventually
 * disagree, and the wrong one is always the flattering one.
 */
function report(title: string, truth: Reference, system: Span[]): Score {
  const result = score(truth, system)
  console.log(formatScore(title, result))
  const sweep = collarSensitivity(truth, system)
  console.log(
    '  collar sweep           ' +
      sweep.map((row) => `${row.collarMs}ms ${percent(row.unexplainedRate)}`).join('   '),
  )
  return result
}

/**
 * Per-cluster forensics for one run, in a form that greps across many runs.
 *
 * The live path's speaker error is bimodal — roughly 28% or roughly 54%, with
 * nothing in between — so a single run's headline number says almost nothing.
 * These lines are what distinguishes the two modes: when each cluster first
 * spoke, how much speech it holds, and how much of it belongs to each real
 * person. A cluster that is 60/40 rather than 95/5 is a contaminated centroid,
 * and its first span says when the contamination got in.
 */
function trace(truth: Span[], system: Span[], label: string): void {
  const people = [...new Set(truth.map((span) => span.speaker))].sort()
  const clusters = new Map<string, Span[]>()
  for (const span of system) {
    const spans = clusters.get(span.speaker) ?? []
    spans.push(span)
    clusters.set(span.speaker, spans)
  }
  const rows = [...clusters]
    .map(([id, spans]) => {
      const speechMs = spans.reduce((total, span) => total + (span.end_ms - span.start_ms), 0)
      const byPerson = people.map((person) => ({
        person,
        ms: truth
          .filter((reference) => reference.speaker === person)
          .reduce((total, reference) => total + spans.reduce((n, s) => n + overlapMs(reference, s), 0), 0),
      }))
      const covered = byPerson.reduce((total, entry) => total + entry.ms, 0)
      const dominant = [...byPerson].sort((a, b) => b.ms - a.ms)[0]
      return {
        id,
        firstMs: Math.min(...spans.map((span) => span.start_ms)),
        speechMs,
        purity: covered === 0 ? 0 : dominant.ms / covered,
        dominant: dominant.person,
        mix: byPerson.map((entry) => `${entry.person}:${Math.round(entry.ms / 1000)}s`).join(' '),
      }
    })
    .sort((a, b) => a.firstMs - b.firstMs)

  // Cause or consequence? A seed that is already mixed while it is being formed
  // poisons everything compared against it afterwards. A seed that only looks
  // mixed at the end of the run is a symptom, not the disease. So purity is
  // reported over an early window as well as overall.
  for (const span of system) console.log(`SPAN ${label} ${span.speaker} ${span.start_ms} ${span.end_ms}`)
  for (const span of truth) console.log(`REF ${label} ${span.speaker} ${span.start_ms} ${span.end_ms}`)
  for (const row of rows) {
    console.log(
      `TRACE ${label} cluster=${row.id} first=${(row.firstMs / 1000).toFixed(1)}s ` +
        `speech=${(row.speechMs / 1000).toFixed(1)}s purity=${(row.purity * 100).toFixed(0)}% ` +
        `dominant=${row.dominant} mix=[${row.mix}]`,
    )
  }
  // The first cluster is the one every later window is compared against, so if
  // the mode is decided early this is where it shows.
  const seed = rows[0]
  if (seed) {
    console.log(
      `TRACE ${label} seed=${seed.id} seedPurity=${(seed.purity * 100).toFixed(0)}% ` +
        `seedFirst=${(seed.firstMs / 1000).toFixed(1)}s clusters=${rows.length}`,
    )
  }
}

async function main(): Promise<void> {
  loadEnv()
  resetAudioConfig()
  if (!hasRealFixture('dorm-9pm.wav')) {
    console.error(missingFixtureNotice('dorm-9pm.wav'))
    process.exitCode = 1
    return
  }
  const args = new Set(process.argv.slice(2))
  const live = !args.has('--provider=whisper')
  const runFinal = !args.has('--no-final')
  const speed = Number([...args].find((arg) => arg.startsWith('--speed='))?.split('=')[1] ?? 8)

  const config = audioConfig()
  readAudioConfig()
  const notes = configNotes()
  console.log('audio config')
  console.log(`  embed floor            ${config.embedMinMs} ms`)
  console.log(`  provisional / confirmed ${config.provisionalSpeechMs} / ${config.confirmedSpeechMs} ms`)
  console.log(`  sidecar                ${config.sidecarUrl}`)
  for (const note of notes) console.log(`  override               ${note}`)

  const health = await fetch(`${config.sidecarUrl}/health`).then(
    (response) => response.json() as Promise<{ ok: boolean }>,
    () => null,
  )
  if (!health?.ok) {
    console.error(
      `\nThe ECAPA sidecar at ${config.sidecarUrl} is not answering. Start it with:\n` +
        '  cd sidecar && ECAPA_CACHE_DIR=.cache/ecapa .venv/bin/python -m uvicorn app:app ' +
        '--host 127.0.0.1 --port 8099',
    )
    process.exitCode = 1
    return
  }

  const { samples, sampleRate } = readWav(readFileSync(realFixturePath('dorm-9pm.wav')))
  if (sampleRate !== SAMPLE_RATE) throw new Error(`fixture is ${sampleRate} Hz, expected ${SAMPLE_RATE}`)
  const truth = reference()
  const truthSpans = truth.spans
  const firstWordMs = new Map<string, number>()
  for (const span of truthSpans) {
    firstWordMs.set(span.speaker, Math.min(firstWordMs.get(span.speaker) ?? Infinity, span.start_ms))
  }

  const bus = new AmeliaBus()
  const provider = live
    ? new OpenAIRealtimeProvider({ apiKey: config.openaiApiKey })
    : new WhisperReplayProvider()
  console.log(
    `\nprovider ${live ? 'openai realtime (what the phone runs)' : 'whisper replay (offline, not production)'}` +
      `, window split ${config.windowSplitEnabled ? 'on' : 'off'}`,
  )
  let positionMs = 0
  const identity = recordingIdentity(() => positionMs)
  const session = new AudioSession({
    conversationId: `eval-${Date.now()}`,
    bus,
    provider,
    identity,
    utterances: null,
  })

  const started = Date.now()
  const frameMs = (AUDIO_FRAME_SAMPLES / SAMPLE_RATE) * 1000
  for (let offset = 0; offset < samples.length; offset += AUDIO_FRAME_SAMPLES) {
    await session.pushAudio(samples.subarray(offset, offset + AUDIO_FRAME_SAMPLES))
    positionMs += frameMs
    if (speed > 0) await new Promise((resolve) => setTimeout(resolve, frameMs / speed))
  }
  const pushedMs = Date.now() - started
  const lagMs = Date.now()
  await session.drain()
  const drainMs = Date.now() - lagMs
  await session.end()
  const liveWallMs = Date.now() - started

  // Scored by person, not cluster: a diarizer that splits one voice into two
  // labels has still succeeded if identity puts both labels on one person, and
  // that recombination is the whole point of pooling voiceprints.
  const spans = (): Span[] =>
    session.transcript.map((record) => ({
      speaker: record.person_id ?? record.session_speaker,
      start_ms: record.start_ms,
      end_ms: record.end_ms,
    }))
  const liveSpans = spans()
  const attributionByUtterance = new Map(
    session.transcript.map((record) => [record.utterance_id, { session_speaker: record.person_id ?? record.session_speaker }]),
  )

  const audioSeconds = samples.length / SAMPLE_RATE
  console.log(
    `\nlive pass: ${liveSpans.length} utterances for ${audioSeconds.toFixed(0)} s of audio, ` +
      `pushed at ${speed}x in ${(pushedMs / 1000).toFixed(1)} s wall`,
  )
  console.log(
    `  sidecar backlog at end of stream: ${(drainMs / 1000).toFixed(1)} s. ` +
      (drainMs < pushedMs * 0.2
        ? 'The sidecar kept up.'
        : 'The sidecar did NOT keep up at this speed; embedding is the bottleneck.'),
  )
  console.log(`  session mean supplied to identity: ${identity.sawSessionMean ? 'yes' : 'NO'}`)
  if (session.degradedReason) console.log(`  DEGRADED: ${session.degradedReason}`)
  const liveScore = report('live pass (voiceprint clustering only)', truth, liveSpans)
  if (args.has('--trace')) trace(truthSpans, liveSpans, 'live')

  reportLatency(truthSpans, liveSpans, liveScore, identity.attributedAt, attributionByUtterance, firstWordMs)

  if (!runFinal) {
    console.log('\nfinal pass skipped (--no-final)')
    return
  }
  console.log('\nfinal pass: whisper over the whole file, pyannote over the whole file, joined at word level…')
  const finalStarted = Date.now()
  const final = await session.runFinalPass()
  if (!final.ran) {
    console.log(`  GATE: did not run — ${final.reason}`)
    return
  }
  if (final.reason) {
    console.log(`  did not apply — ${final.reason}`)
    return
  }
  console.log(
    `  ${final.segments.length} turns, ${final.labels.length} speakers, ` +
      `${final.corrected} utterances rewritten and ${final.superseded ?? 0} superseded ` +
      `in ${((Date.now() - finalStarted) / 1000).toFixed(0)} s`,
  )
  console.log(
    `  ${final.attributedWords ?? 0}/${final.totalWords ?? 0} words attributed, ` +
      `${((final.overlapMs ?? 0) / 1000).toFixed(0)} s of simultaneous speech, ` +
      `diarizer took ${((final.diarizeMs ?? 0) / 1000).toFixed(0)} s`,
  )
  // The stored reference is one run of the old chunked diarization. Scoring
  // this pass's raw segmentation against it shows how far apart two
  // segmentations of the same audio can be, which is the noise floor every
  // number here sits on — and the reference is now the weaker of the two.
  report(
    'this run\'s segmentation vs the stored reference',
    truth,
    final.segments.map((segment) => ({
      speaker: segment.speaker,
      start_ms: segment.start_ms,
      end_ms: segment.end_ms,
    })),
  )
  report('final pass applied', truth, spans())
}

/**
 * How long each person spoke before the pipeline had a name for them, in stream
 * time rather than wall time — that is what the user experiences, and it is
 * comparable across replay speeds.
 */
function reportLatency(
  truth: Span[],
  system: Span[],
  scored: Score,
  attributedAt: Map<string, number>,
  records: Map<string, { session_speaker: string; person_id?: string }>,
  firstWordMs: Map<string, number>,
): void {
  console.log('\ntime to first attribution (stream time from the person\'s first word)')
  for (const [person, cluster] of [...scored.mapping].sort()) {
    const first = firstWordMs.get(person) ?? 0
    let earliest: number | null = null
    for (const [utteranceId, at] of attributedAt) {
      const record = records.get(utteranceId)
      if (record?.session_speaker !== cluster) continue
      if (earliest === null || at < earliest) earliest = at
    }
    if (earliest === null) {
      console.log(`  ${person.padEnd(8)} never attributed`)
      continue
    }
    // A cluster can resolve before its person's own first reference word, when
    // the cluster was built from speech the reference attributes to someone
    // else. Their first word is then named the instant it appears, so the
    // latency a user would perceive is zero, not negative.
    const latencyMs = Math.max(0, earliest - first)
    console.log(
      `  ${person.padEnd(8)} ${(latencyMs / 1000).toFixed(1)} s ` +
        `(first word at ${(first / 1000).toFixed(1)} s, cluster named at ${(earliest / 1000).toFixed(1)} s)`,
    )
  }
  const unattributed = system.filter((span) => !scored.mapping.has(span.speaker))
  if (unattributed.length === 0) console.log('  every cluster mapped to a person')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
