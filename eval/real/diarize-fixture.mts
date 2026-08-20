/**
 * Run the shipping diarization path over a real recording and save the result.
 *
 *   npx tsx eval/real/diarize-fixture.mts dorm-9pm
 *
 * This goes through server/audio's own sidecar client, so the numbers it prints
 * are numbers about the code that ships rather than about a script beside it.
 * The output lands in fixtures/real/<stem>.pyannote.json, which the join tests
 * and eval/diarization.mts read.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { diarizeAudio } from '../../server/audio/diarize-sidecar'
import { readWav } from '../../server/audio/wav'
import { realFixturePath } from '../../fixtures/real-audio'

const stem = process.argv[2] ?? 'dorm-9pm'
const { samples } = readWav(readFileSync(realFixturePath(`${stem}.wav`)))
const started = Date.now()
const diarization = await diarizeAudio(samples)
const wallMs = Date.now() - started

writeFileSync(
  realFixturePath(`${stem}.pyannote.json`),
  JSON.stringify({ turns: diarization.turns, speakers: diarization.speakers }, null, 1),
)

const audioS = diarization.durationMs / 1000
console.log(
  `${stem}: ${diarization.turns.length} turns, ${diarization.speakers.length} speakers, ` +
    `${(wallMs / 1000).toFixed(0)}s wall for ${audioS.toFixed(0)}s of audio ` +
    `(${(audioS / (diarization.elapsedMs / 1000)).toFixed(2)}x realtime in the model)`,
)
console.log(`  simultaneous speech: ${(diarization.overlapMs / 1000).toFixed(1)}s`)
for (const speaker of diarization.speakers) {
  const ms = diarization.turns
    .filter((turn) => turn.speaker === speaker)
    .reduce((total, turn) => total + (turn.end_ms - turn.start_ms), 0)
  console.log(`  ${speaker}: ${(ms / 1000).toFixed(1)}s`)
}
