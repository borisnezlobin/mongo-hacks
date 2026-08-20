/**
 * How much of each recording our evaluation can actually see.
 *
 * This exists because a change once measured as a 33% reduction in landmark
 * merges while fixing nothing: `M A R T` moved off Vova's label onto Boris's,
 * which is still the wrong person, but no landmark was watching Boris's label
 * for that line, so the error left the count. DER did not catch it either,
 * because the dorm-40min reference labels three of the seven people in the
 * room, so speech moving between the other four is free.
 *
 * That is not a story about one change. It is the ceiling on every measurement
 * anyone makes here, so it is worth a number rather than a warning.
 *
 * Three questions, in order of how much they cost us:
 *
 *   1. What fraction of speech is nobody's, as far as the reference knows?
 *   2. Which diarizer labels does no landmark occupy? An error that lands on
 *      one of those is invisible in both directions.
 *   3. Of the person pairs that could be merged, how many can a landmark pair
 *      actually discriminate?
 *
 *   npx tsx eval/real/blind-spots.mts
 */

import { joinTranscriptToTurns } from '../../server/audio/attribute-recording'
import type { SpeakerTurn } from '../../server/audio/diarize-sidecar'
import { readTimedTranscript, type WhisperResponse } from '../../server/audio/whisper-client'
import { readRealFixture } from '../../fixtures/real-audio'
import { dormReference, ninePmReference } from '../ground-truth'
import { checkLandmarks, LANDMARKS, type Landmark } from '../landmarks'
import { overlapMs, type Reference, type Span } from '../scoring'

const RECORDINGS = [
  { stem: 'dorm-40min' as const, reference: dormReference() as Reference | null },
  { stem: 'dorm-9pm' as const, reference: ninePmReference() },
]

/** Union of spans, in seconds, ignoring who said them. */
function unionSeconds(spans: readonly Span[]): number {
  const sorted = [...spans].filter((s) => s.end_ms > s.start_ms).sort((a, b) => a.start_ms - b.start_ms)
  let total = 0
  let end = -Infinity
  for (const span of sorted) {
    const from = Math.max(span.start_ms, end)
    if (span.end_ms > from) total += span.end_ms - from
    end = Math.max(end, span.end_ms)
  }
  return total / 1000
}

function pct(part: number, whole: number): string {
  return whole <= 0 ? '  n/a' : `${((100 * part) / whole).toFixed(1)}%`.padStart(6)
}

for (const { stem, reference } of RECORDINGS) {
  if (!reference) {
    console.log(`\n${stem}: no reference available`)
    continue
  }
  const turns = readRealFixture<{ turns: SpeakerTurn[] }>(`${stem}.pyannote.json`).turns
  const transcript = readTimedTranscript(readRealFixture<WhisperResponse>(`${stem}.whisper.json`))
  const asSpans: Span[] = turns.map((turn) => ({ ...turn }))
  const labels = [...new Set(turns.map((turn) => turn.speaker))].sort()

  console.log(`\n${'='.repeat(78)}\n${stem}\n${'='.repeat(78)}`)

  // ---- 1. speech the reference has no opinion about -------------------------
  const diarized = unionSeconds(asSpans)
  const scored = unionSeconds(reference.spans)
  const excluded = unionSeconds(reference.excluded)
  let unseen = 0
  let unseenTurns = 0
  for (const turn of turns) {
    const covered = [...reference.spans, ...reference.excluded].reduce(
      (sum, span) => sum + overlapMs(turn, span),
      0,
    )
    const length = turn.end_ms - turn.start_ms
    if (covered < 0.5 * length) unseenTurns += 1
    unseen += Math.max(0, length - covered) / 1000
  }
  console.log(`\nspeech the evaluation can see`)
  console.log(`  recording                 ${(reference.durationMs / 1000).toFixed(0)}s`)
  console.log(`  diarized speech           ${diarized.toFixed(0)}s`)
  console.log(`  labelled to a person      ${scored.toFixed(0)}s  ${pct(scored, diarized)} of diarized speech`)
  console.log(`  withheld as uncertain     ${excluded.toFixed(0)}s  ${pct(excluded, diarized)}`)
  console.log(
    `  no reference at all       ${unseen.toFixed(0)}s  ${pct(unseen, diarized)}` +
      `   (${unseenTurns} of ${turns.length} turns are mostly this)`,
  )
  console.log(
    `  people: ${reference.truePeople} in the room, ` +
      `${new Set(reference.spans.map((s) => s.speaker)).size} ever labelled, ` +
      `${labels.length} labels emitted`,
  )

  // ---- 2. labels no landmark occupies ---------------------------------------
  const run = joinTranscriptToTurns(transcript.words, turns, 0, transcript.segments)
  const marks = LANDMARKS.filter((mark) => mark.recording === stem)
  const landedOn = new Map<Landmark, string | null>()
  for (const mark of marks) {
    let best: { speaker: string; ms: number } | null = null
    for (const segment of run.segments) {
      const shared = Math.min(mark.end_ms, segment.end_ms) - Math.max(mark.at_ms, segment.start_ms)
      if (shared > 0 && (!best || shared > best.ms)) best = { speaker: segment.speaker, ms: shared }
    }
    landedOn.set(mark, best?.speaker ?? null)
  }
  const occupied = new Set([...landedOn.values()].filter((x): x is string => x !== null))

  const secondsOf = new Map<string, number>()
  const coveredOf = new Map<string, number>()
  const dominant = new Map<string, string>()
  for (const label of labels) {
    const mine = turns.filter((turn) => turn.speaker === label)
    secondsOf.set(label, unionSeconds(mine))
    const per = new Map<string, number>()
    let covered = 0
    for (const turn of mine) {
      for (const span of reference.spans) {
        const shared = overlapMs(turn, span)
        if (shared > 0) {
          per.set(span.speaker, (per.get(span.speaker) ?? 0) + shared)
          covered += shared
        }
      }
    }
    coveredOf.set(label, covered / 1000)
    const top = [...per].sort((a, b) => b[1] - a[1])[0]
    dominant.set(label, top ? `${top[0]} ${(100 * top[1] / Math.max(covered, 1)).toFixed(0)}%` : '-')
  }

  console.log(`\nper label: how much of it any landmark or reference span is watching`)
  console.log(`  label         speech   reference-labelled   dominant person   landmarks on it`)
  for (const label of labels.sort((a, b) => (secondsOf.get(b) ?? 0) - (secondsOf.get(a) ?? 0))) {
    const here = marks.filter((mark) => landedOn.get(mark) === label).length
    console.log(
      `  ${label.padEnd(12)} ${(secondsOf.get(label) ?? 0).toFixed(0).padStart(5)}s   ` +
        `${(coveredOf.get(label) ?? 0).toFixed(0).padStart(5)}s ${pct(coveredOf.get(label) ?? 0, secondsOf.get(label) ?? 0)}      ` +
        `${(dominant.get(label) ?? '-').padEnd(16)}  ${here === 0 ? 'NONE - invisible' : String(here)}`,
    )
  }
  const blindSeconds = labels
    .filter((label) => !occupied.has(label))
    .reduce((sum, label) => sum + (secondsOf.get(label) ?? 0), 0)
  console.log(
    `  ${labels.length - occupied.size} of ${labels.length} labels carry no landmark at all, ` +
      `holding ${blindSeconds.toFixed(0)}s (${pct(blindSeconds, diarized)} of diarized speech). ` +
      `An error that lands there leaves the merge count.`,
  )

  // ---- 3. which person pairs a landmark pair can discriminate ---------------
  const positive = [...new Set(marks.filter((m) => m.person).map((m) => m.person as string))].sort()
  const negativeOnly = [...new Set(marks.filter((m) => !m.person && m.notPerson).map((m) => m.notPerson as string))]
    .filter((name) => !positive.includes(name))
    .sort()
  const report = checkLandmarks(stem, run.segments)
  const discriminated = new Set<string>()
  for (const pair of report.pairs) {
    if (pair.expect !== 'different') continue
    if (pair.a.person && pair.b.person) {
      discriminated.add([pair.a.person, pair.b.person].sort().join(' / '))
    }
  }
  const people = reference.truePeople
  const possiblePairs = (people * (people - 1)) / 2
  console.log(`\nwhich merges the landmark set can even ask about`)
  console.log(`  people with a line that names them        ${positive.length}: ${positive.join(', ')}`)
  if (negativeOnly.length) {
    console.log(
      `  people only ever ruled OUT, never pinned  ${negativeOnly.length}: ${negativeOnly.join(', ')}` +
        `   (a merge onto these is undetectable)`,
    )
  }
  console.log(`  landmark constraints in force             ${report.pairs.length}`)
  console.log(
    `  person pairs a merge could join           ${possiblePairs}  (${people} people in the room)`,
  )
  console.log(
    `  of those, discriminated by two named lines ${discriminated.size}  ` +
      `${pct(discriminated.size, possiblePairs)} of the pair space`,
  )
  for (const pair of [...discriminated].sort()) console.log(`      ${pair}`)
}
