/**
 * What withholding a name below the duration floor costs, and what it buys.
 *
 * `eval/real/duration_floor.py` measured the point where this microphone stops
 * carrying speaker identity: at 0.5 s the same-or-different decision is a coin
 * flip for two independent embedding architectures, and it only reaches a
 * usable error rate somewhere past 2 s. A turn shorter than that has a label
 * that was read off too little speech to mean anything, and every consumer
 * downstream treats it as if it meant something.
 *
 * So this sweeps the floor rather than picking one. Abstention is not free: an
 * unattributed line carries no facts and cannot be searched by person, so the
 * honest way to present it is both columns side by side.
 *
 *   npx tsx eval/real/abstain_sweep.mts
 *
 * The landmark verdicts are the judge. The speech that goes dark is the bill.
 */

import { checkLandmarks } from '../landmarks'
import { hasRealFixture, readRealFixture } from '../../fixtures/real-audio'
import type { SpeakerTurn } from '../../server/audio/diarize-sidecar'
import { joinWordsToSpeakers } from '../../server/audio/word-join'
import { readTimedTranscript, type WhisperResponse } from '../../server/audio/whisper-client'
import type { AttributedSegment } from '../scoring'

const FLOORS = [0, 250, 500, 750, 1_000, 1_500, 2_000, 3_000]

const RECORDINGS = [
  { stem: 'dorm-9pm', recording: 'dorm-9pm' as const, unlocatable: [] as string[] },
  { stem: 'dorm-40min', recording: 'dorm-40min' as const, unlocatable: ['Goodnight.'] },
  // Held out: three people, five voices, nothing tuned against it. It has no
  // landmarks, so only the cost columns mean anything here.
  { stem: 'jerry-45min', recording: null, unlocatable: [] as string[] },
]

function inputs(stem: string) {
  if (!hasRealFixture(`${stem}.whisper.json`) || !hasRealFixture(`${stem}.pyannote.json`)) return null
  const transcript = readTimedTranscript(readRealFixture<WhisperResponse>(`${stem}.whisper.json`))
  const turns = readRealFixture<{ turns: SpeakerTurn[] }>(`${stem}.pyannote.json`).turns
  return { words: transcript.words, sentences: transcript.segments, turns }
}

for (const { stem, recording, unlocatable } of RECORDINGS) {
  const data = inputs(stem)
  if (!data) { console.log(`${stem}: fixtures absent`); continue }
  const turnMs = data.turns.reduce((total, turn) => total + (turn.end_ms - turn.start_ms), 0)
  console.log(`\n${stem}  ${data.words.length} words, ${data.turns.length} turns, ${(turnMs / 1000).toFixed(0)}s diarized`)
  console.log('   floor   lines  interj   words named   speech named   merges  splits  unresolved   "I\'m Vova"')

  for (const minTurnMs of FLOORS) {
    const lines = joinWordsToSpeakers(data.words, data.turns, { minTurnMs, segments: data.sentences })
    const named = lines.filter((line) => line.speaker !== null)
    const namedWords = named.reduce((total, line) => total + line.words.length, 0)
    const namedMs = named.reduce((total, line) => total + (line.end_ms - line.start_ms), 0)
    const allMs = lines.reduce((total, line) => total + (line.end_ms - line.start_ms), 0)
    const interjections = lines.filter(
      (line, index) =>
        index > 0 && index < lines.length - 1 && line.words.length <= 2 &&
        lines[index - 1].speaker !== null &&
        lines[index - 1].speaker === lines[index + 1].speaker &&
        line.speaker !== lines[index - 1].speaker,
    ).length

    let verdicts = '     -       -          -'
    if (recording) {
      const segments: AttributedSegment[] = named.map((line) => ({
        speaker: line.speaker as string,
        text: line.text,
        start_ms: line.start_ms,
        end_ms: line.end_ms,
      }))
      const report = checkLandmarks(recording, segments)
      const locatable = (pair: { a: { quote: string }; b: { quote: string } }) =>
        !unlocatable.includes(pair.a.quote) && !unlocatable.includes(pair.b.quote)
      const merges = report.merges.filter(locatable).length
      const splits = report.splits.filter(locatable).length
      verdicts = `${String(merges).padStart(6)}  ${String(splits).padStart(6)}  ${String(report.total - report.covered).padStart(10)}`
    }

    const intro = lines.find((line) => line.text.includes("I'm Vova"))
    const introState = intro ? (intro.speaker ? `own line, named` : `own line, UNNAMED`) : 'absent'
    console.log(
      `  ${String(minTurnMs).padStart(5)}  ${String(lines.length).padStart(6)}  ${String(interjections).padStart(6)}` +
      `   ${(100 * namedWords / data.words.length).toFixed(1).padStart(6)}%` +
      `   ${(100 * namedMs / allMs).toFixed(1).padStart(9)}%   ${verdicts}   ${introState}`,
    )
  }
}
