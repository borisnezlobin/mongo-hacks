/**
 * The merge and split counts for a candidate diarization, from the real checker.
 *
 * `word-join.measured.test.ts` runs `checkLandmarks` against the shipped
 * fixture. This runs the same function against any candidate file, so a
 * proposed pipeline can be compared with the recorded `knownMerges` and
 * `knownSplits` baselines without editing the test or overwriting the fixture
 * those baselines were measured on.
 *
 * Always read it next to `landmark-labels.mts`. A merge leaves this list just
 * as readily by moving onto a label no landmark occupies as by being fixed, and
 * only the label table can tell the two apart.
 *
 *   npx tsx eval/real/landmark-check.mts <stem> [candidate.json]
 */

import { readFileSync } from 'node:fs'
import { checkLandmarks } from '../landmarks'
import { joinWordsToSpeakers } from '../../server/audio/word-join'
import type { SpeakerTurn } from '../../server/audio/diarize-sidecar'
import { readTimedTranscript, type WhisperResponse } from '../../server/audio/whisper-client'
import { readRealFixture } from '../../fixtures/real-audio'

const stem = (process.argv[2] ?? 'dorm-40min') as 'dorm-9pm' | 'dorm-40min'
const candidate = process.argv[3]

const transcript = readTimedTranscript(readRealFixture<WhisperResponse>(`${stem}.whisper.json`))
const turns = candidate
  ? (JSON.parse(readFileSync(candidate, 'utf8')) as { turns: SpeakerTurn[] }).turns
  : readRealFixture<{ turns: SpeakerTurn[] }>(`${stem}.pyannote.json`).turns

const lines = joinWordsToSpeakers(transcript.words, turns, { segments: transcript.segments })
// Lines the join left unattributed are dropped rather than given a placeholder
// speaker: checkLandmarks reports a landmark it cannot locate as uncovered,
// which is the honest answer, and inventing a label would turn that into a
// merge or a split that nothing measured.
const attributed = lines.flatMap((line) =>
  line.speaker === null ? [] : [{ ...line, speaker: line.speaker }],
)
const report = checkLandmarks(stem, attributed)

console.log(`${stem}  <- ${candidate ?? 'shipped fixture'}`)
const name = (pair: { a: { quote: string }; b: { quote: string } }) =>
  `${pair.a.quote} / ${pair.b.quote}`

console.log(`  merges ${report.merges.length}   splits ${report.splits.length}   `
  + `covered ${report.covered}/${report.total}`)
for (const merge of report.merges) console.log(`  MERGE  ${name(merge)}`)
for (const split of report.splits) console.log(`  SPLIT  ${name(split)}`)
