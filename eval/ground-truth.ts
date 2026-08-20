/**
 * The two references the harness scores against.
 *
 * Neither of them imports anything from `server/`. That is deliberate: a
 * reference that is built by the code under test moves whenever the code under
 * test moves, and then an improvement and a regression look identical. The
 * folding rule below is a copy of `mergeShortLabels` for exactly that reason,
 * and it should be left as a copy.
 */

import { existsSync, readFileSync } from 'node:fs'
import { hasRealFixture, readRealFixture } from '../fixtures/real-audio'
import type { Reference, Span } from './scoring'

/** The short recording: three people, known by the person who was in the room. */
const NINE_PM_PEOPLE: Record<string, string> = { A: 'Joshua', C: 'Boris', G: 'Tarun' }

/**
 * Labels holding less than this are the diarizer over-splitting an interjection,
 * and get folded into whichever substantial label they sit between.
 */
const FOLD_BELOW_MS = 4_000

interface DiarizedFixture {
  segments: { speaker: string; start: number; end: number }[]
}

interface GroundTruthFixture {
  duration_s: number
  true_people: number
  coverage: {
    diarized_speech_s: number
    scored_speech_s: number
    scored_fraction_of_speech: number
    people_scored: number
    people_named: number
  }
  people: { id: string; name: string | null; confidence: string; seconds: number; labels: string[] }[]
  spans: { start_ms: number; end_ms: number; speaker: string; label: string }[]
  excluded: { start_ms: number; end_ms: number; reason: string; label: string }[]
}

function fold(segments: Span[]): Span[] {
  const total = new Map<string, number>()
  for (const segment of segments) {
    total.set(segment.speaker, (total.get(segment.speaker) ?? 0) + (segment.end_ms - segment.start_ms))
  }
  const substantial = new Set([...total].filter(([, ms]) => ms >= FOLD_BELOW_MS).map(([id]) => id))
  const out: Span[] = []
  for (const [index, segment] of segments.entries()) {
    if (substantial.has(segment.speaker)) {
      out.push({ ...segment })
      continue
    }
    const before = segments.slice(0, index).reverse().find((other) => substantial.has(other.speaker))
    const after = segments.slice(index + 1).find((other) => substantial.has(other.speaker))
    const nearest = !before ? after : !after
      ? before
      : segment.start_ms - before.end_ms <= after.start_ms - segment.end_ms
        ? before
        : after
    if (nearest) out.push({ ...segment, speaker: nearest.speaker })
  }
  return out
}

export const NINE_PM_WAV = 'dorm-9pm.wav'
export const DORM_WAV = 'dorm-40min.wav'

/**
 * The regression case: three people, three minutes, ground truth the owner can
 * state from memory. It is here to catch the thing a 48-minute recording cannot,
 * which is a change that only helps because it was tuned on the 48-minute
 * recording. If a change moves the long recording and leaves this one alone,
 * that is interesting. If it moves the long recording and breaks this one, it
 * is overfitting.
 */
export function ninePmReference(): Reference | null {
  if (!hasRealFixture('dorm-9pm.diarize.json')) return null
  const raw = readRealFixture<DiarizedFixture>('dorm-9pm.diarize.json')
  const spans = fold(
    raw.segments.map((segment) => ({
      speaker: segment.speaker,
      start_ms: Math.round(segment.start * 1000),
      end_ms: Math.round(segment.end * 1000),
    })),
  )
    .map((span) => ({ ...span, speaker: NINE_PM_PEOPLE[span.speaker] ?? span.speaker }))
    .filter((span) => span.end_ms > span.start_ms)

  return {
    spans,
    // Nothing is withheld here, and that is itself worth knowing: this
    // reference is one run of one diarizer that a human agreed with, so it is
    // confident everywhere and wrong in places nobody has found yet.
    excluded: [],
    durationMs: Math.max(...spans.map((span) => span.end_ms)),
    truePeople: 3,
  }
}

/**
 * The 48-minute recording, labelled only where the evidence converged.
 *
 * Roughly a third of the speech is in `spans` and the rest is in `excluded`.
 * Do not be tempted to fill the gap in: the excluded time is excluded because
 * three independent signals disagreed about it, and the file that builds it
 * (eval/real/build_ground_truth.py) records what disagreed and which two
 * minutes of audio would settle each case.
 */
export function dormReference(): (Reference & { meta: GroundTruthFixture }) | null {
  const path = groundTruthPath()
  if (!existsSync(path)) return null
  const raw = JSON.parse(readFileSync(path, 'utf8')) as GroundTruthFixture
  return {
    spans: raw.spans.map((span) => ({
      speaker: span.speaker,
      start_ms: span.start_ms,
      end_ms: span.end_ms,
    })),
    excluded: raw.excluded.map((span) => ({
      speaker: 'unknown',
      start_ms: span.start_ms,
      end_ms: span.end_ms,
    })),
    durationMs: Math.round(raw.duration_s * 1000),
    // Seven people were in the room. Three of them are in `spans`; the other
    // four are somewhere in `excluded`. Reporting the true count rather than the
    // labelled count is what stops "found 3 speakers" reading as a success.
    truePeople: raw.true_people,
    meta: raw,
  }
}

export function groundTruthPath(): string {
  return new URL('./real/ground-truth.json', import.meta.url).pathname
}
