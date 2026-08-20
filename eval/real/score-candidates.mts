/**
 * Score a directory of candidate diarizations the way eval:diarization scores
 * the shipping one, so a sweep can be read as a table instead of a stack of
 * reports.
 *
 *   npx tsx eval/real/score-candidates.mts <dir> [--stem dorm-9pm]
 *
 * Every candidate goes through the same join, the same reference and the same
 * landmark check as the shipping fixture. The landmark columns are the ones to
 * read: a merge or a split is a fact about people that no error rate can see.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { joinTranscriptToTurns } from '../../server/audio/attribute-recording'
import type { SpeakerTurn } from '../../server/audio/diarize-sidecar'
import { readTimedTranscript, type WhisperResponse } from '../../server/audio/whisper-client'
import { readRealFixture } from '../../fixtures/real-audio'
import { dormReference, ninePmReference } from '../ground-truth'
import { checkLandmarks } from '../landmarks'
import { overlapMs, percent, score, type AttributedSegment, type Reference } from '../scoring'

/**
 * How much of a system label's labelled time belongs to its dominant person.
 *
 * The rates cannot see a merge: two people on one label costs nothing in
 * seconds when the mapping picks whichever of them speaks more, and the speaker
 * count still looks right if something else split in compensation. Purity is
 * the direct measurement of the thing the landmarks catch only where a landmark
 * happens to fall.
 */
function labelPurity(reference: Reference, segments: AttributedSegment[]) {
  const perLabel = new Map<string, Map<string, number>>()
  for (const segment of segments) {
    for (const span of reference.spans) {
      const shared = overlapMs(segment, span)
      if (shared <= 0) continue
      const counts = perLabel.get(segment.speaker) ?? new Map<string, number>()
      counts.set(span.speaker, (counts.get(span.speaker) ?? 0) + shared)
      perLabel.set(segment.speaker, counts)
    }
  }
  let impure = 0
  let worst = 1
  for (const counts of perLabel.values()) {
    const total = [...counts.values()].reduce((sum, ms) => sum + ms, 0)
    if (total < 10_000) continue
    const dominant = Math.max(...counts.values())
    const purity = dominant / total
    if (purity < 0.9) impure += 1
    worst = Math.min(worst, purity)
  }
  return { impure, worst }
}

const dir = process.argv[2]
const only = process.argv.includes('--stem') ? process.argv[process.argv.indexOf('--stem') + 1] : null

const references: Record<string, { recording: 'dorm-9pm' | 'dorm-40min'; reference: Reference | null }> = {
  'dorm-9pm': { recording: 'dorm-9pm', reference: ninePmReference() },
  'dorm-40min': { recording: 'dorm-40min', reference: dormReference() },
}

const wordsFor = new Map<string, ReturnType<typeof readTimedTranscript>['words']>()
function words(stem: string) {
  if (!wordsFor.has(stem)) {
    wordsFor.set(stem, readTimedTranscript(readRealFixture<WhisperResponse>(`${stem}.whisper.json`)).words)
  }
  return wordsFor.get(stem)!
}

function simultaneousMs(turns: SpeakerTurn[]): number {
  const ordered = [...turns].sort((a, b) => a.start_ms - b.start_ms)
  let total = 0
  for (let i = 0; i < ordered.length; i += 1) {
    for (let j = i + 1; j < ordered.length; j += 1) {
      if (ordered[j].start_ms >= ordered[i].end_ms) break
      if (ordered[j].speaker === ordered[i].speaker) continue
      total += Math.max(0, Math.min(ordered[i].end_ms, ordered[j].end_ms) - Math.max(ordered[i].start_ms, ordered[j].start_ms))
    }
  }
  return total
}

interface Row {
  name: string
  stem: string
  config: Record<string, unknown>
  speakers: number
  unexplained: number
  wrong: number
  missed: number
  falseAlarm: number
  der: number
  merges: number
  splits: number
  spurious: number
  covered: string
  impure: number
  worstPurity: number
  recalls: string
}

const rows: Row[] = []
for (const file of readdirSync(dir).filter((name) => name.endsWith('.json')).sort()) {
  const stem = file.split('__')[0]
  if (only && stem !== only) continue
  const target = references[stem]
  if (!target?.reference) continue
  const payload = JSON.parse(readFileSync(join(dir, file), 'utf8')) as {
    turns: SpeakerTurn[]
    speakers: string[]
    config?: Record<string, unknown>
  }
  // A candidate covering only part of the recording is scored only over that
  // part; everything outside its window is withheld rather than counted as
  // speech it failed to produce.
  const from = (payload.config?.window_from_ms as number | undefined) ?? 0
  const to = (payload.config?.window_to_ms as number | undefined) ?? Number.MAX_SAFE_INTEGER
  const windowed: Reference =
    from === 0 && to === Number.MAX_SAFE_INTEGER
      ? target.reference
      : {
          ...target.reference,
          spans: target.reference.spans
            .map((span) => ({
              ...span,
              start_ms: Math.max(span.start_ms, from),
              end_ms: Math.min(span.end_ms, to),
            }))
            .filter((span) => span.end_ms > span.start_ms),
          excluded: [
            ...target.reference.excluded,
            { speaker: 'outside', start_ms: 0, end_ms: from },
            { speaker: 'outside', start_ms: to, end_ms: Number.MAX_SAFE_INTEGER },
          ],
        }
  const run = joinTranscriptToTurns(words(stem), payload.turns, simultaneousMs(payload.turns))
  const segments = run.segments.map((segment) => ({
    speaker: segment.speaker,
    start_ms: segment.start_ms,
    end_ms: segment.end_ms,
  }))
  const result = score(windowed, segments)
  const landmarks = checkLandmarks(target.recording, segments)
  const purity = labelPurity(windowed, segments)
  rows.push({
    name: file.replace('.json', '').replace(`${stem}__`, ''),
    stem,
    config: payload.config ?? {},
    speakers: payload.speakers.length,
    unexplained: result.unexplainedRate,
    wrong: result.confusionMs / result.scoredMs,
    missed: result.missedMs / result.scoredMs,
    falseAlarm: result.falseAlarmMs / result.scoredMs,
    der: result.der,
    spurious: result.spuriousSpeakers.length,
    merges: landmarks.merges.length,
    splits: landmarks.splits.length,
    covered: `${landmarks.covered}/${landmarks.total}`,
    impure: purity.impure,
    worstPurity: purity.worst,
    recalls: result.perPerson
      .map((person) => `${person.person}:${percent(person.recall)}`)
      .join(' '),
  })
}

const header = ['config', 'spk', 'spur', 'unexpl', 'wrong', 'missed', 'FA', 'DER', 'merge', 'split', 'cover', 'impure', 'worstpur']
console.log(header.map((cell, index) => (index === 0 ? cell.padEnd(44) : cell.padStart(7))).join(''))
for (const row of rows) {
  console.log(
    row.name.padEnd(44) +
      String(row.speakers).padStart(7) +
      String(row.spurious).padStart(7) +
      percent(row.unexplained).padStart(7) +
      percent(row.wrong).padStart(7) +
      percent(row.missed).padStart(7) +
      percent(row.falseAlarm).padStart(7) +
      percent(row.der).padStart(7) +
      String(row.merges).padStart(7) +
      String(row.splits).padStart(7) +
      row.covered.padStart(7) +
      String(row.impure).padStart(7) +
      percent(row.worstPurity).padStart(8) +
      '   ' + row.recalls,
  )
}
