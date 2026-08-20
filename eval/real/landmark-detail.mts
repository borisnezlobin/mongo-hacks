/**
 * Which landmark pairs a candidate merges and splits, not how many.
 *
 * score-candidates.mts prints counts, and a count can stay the same while the
 * set changes completely -- trading one merge for one split looks like no
 * movement and is not. The measured test asserts exact lists, so a candidate is
 * only an improvement if its list is a subset of the recorded one.
 *
 *   npx tsx eval/real/landmark-detail.mts eval/real/boot40/<file>.json
 */

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { joinTranscriptToTurns } from '../../server/audio/attribute-recording'
import type { SpeakerTurn } from '../../server/audio/diarize-sidecar'
import { readTimedTranscript, type WhisperResponse } from '../../server/audio/whisper-client'
import { readRealFixture } from '../../fixtures/real-audio'
import { checkLandmarks } from '../landmarks'

for (const path of process.argv.slice(2)) {
  const stem = basename(path).split('__')[0].replace('.pyannote.json', '')
  const recording = stem as 'dorm-9pm' | 'dorm-40min'
  const payload = JSON.parse(readFileSync(path, 'utf8')) as { turns: SpeakerTurn[] }
  const words = readTimedTranscript(readRealFixture<WhisperResponse>(`${stem}.whisper.json`)).words
  const run = joinTranscriptToTurns(words, payload.turns, 0)
  const report = checkLandmarks(recording, run.segments)
  console.log(`\n${basename(path)}`)
  console.log(`  merges (${report.merges.length}):`)
  for (const pair of report.merges) console.log(`    ${pair.a.quote} / ${pair.b.quote}`)
  console.log(`  splits (${report.splits.length}):`)
  for (const pair of report.splits) console.log(`    ${pair.a.quote} / ${pair.b.quote}`)
}
