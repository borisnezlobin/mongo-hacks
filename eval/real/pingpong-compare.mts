/**
 * Lines and two-word interjections for a candidate diarization.
 *
 * `word-join.measured.test.ts` holds ceilings for both. They measure different
 * things and can move in opposite directions: a pass that correctly splits a
 * question from its answer RAISES the line count while lowering true
 * ping-pong, so read them together.
 *
 *   npx tsx eval/real/pingpong-compare.mts <stem> [candidate.json ...]
 */
import { readFileSync } from 'node:fs'
import { joinWordsToSpeakers } from '../../server/audio/word-join'
import type { SpeakerTurn } from '../../server/audio/diarize-sidecar'
import { readTimedTranscript, type WhisperResponse } from '../../server/audio/whisper-client'
import { readRealFixture } from '../../fixtures/real-audio'

const stem = process.argv[2]
const candidates = process.argv.slice(3)
const transcript = readTimedTranscript(readRealFixture<WhisperResponse>(`${stem}.whisper.json`))

const sources: [string, SpeakerTurn[]][] = [
  ['pyannote (baseline)', readRealFixture<{ turns: SpeakerTurn[] }>(`${stem}.pyannote.json`).turns],
  ...candidates.map((path) => [path, (JSON.parse(readFileSync(path, 'utf8')) as { turns: SpeakerTurn[] }).turns] as [string, SpeakerTurn[]]),
]

/** True when a span sits strictly inside one whisper sentence. */
function insideOneSentence(start_ms: number, end_ms: number): boolean {
  return transcript.segments.some(
    (sentence) => sentence.start_ms < start_ms && end_ms < sentence.end_ms,
  )
}

for (const [name, turns] of sources) {
  const lines = joinWordsToSpeakers(transcript.words, turns, { segments: transcript.segments })
  const interjections = lines.filter(
    (line, index) =>
      index > 0 &&
      index < lines.length - 1 &&
      line.words.length <= 2 &&
      lines[index - 1].speaker !== null &&
      lines[index - 1].speaker === lines[index + 1].speaker &&
      line.speaker !== lines[index - 1].speaker,
  )
  // The ones that matter: a short line torn out of the MIDDLE of a sentence is
  // flicker, which is what the ceiling was written to catch. A short line that
  // is a whole sentence is somebody saying "I know." and is not a defect.
  const flicker = interjections.filter((line) => insideOneSentence(line.start_ms, line.end_ms))
  console.log(
    `${name.padEnd(46)} lines ${String(lines.length).padStart(5)}` +
      `   interjections ${String(interjections.length).padStart(4)}` +
      `   mid-sentence ${String(flicker.length).padStart(4)}`,
  )
}

// With --show, print each interjection with the lines either side of it, so a
// short turn that is really a short turn can be told from flicker.
if (process.env.SHOW_INTERJECTIONS) {
  for (const [name, turns] of sources) {
    const lines = joinWordsToSpeakers(transcript.words, turns, { segments: transcript.segments })
    console.log(`\n--- ${name}`)
    lines.forEach((line, index) => {
      if (index === 0 || index === lines.length - 1) return
      const before = lines[index - 1]
      const after = lines[index + 1]
      if (
        line.words.length > 2 ||
        before.speaker === null ||
        before.speaker !== after.speaker ||
        line.speaker === before.speaker
      ) return
      console.log(`  ${(line.start_ms / 1000).toFixed(2)}s  ${before.speaker} ${JSON.stringify(before.text.slice(-34))}`)
      console.log(`         -> ${line.speaker} ${JSON.stringify(line.text)}`)
      console.log(`         ${after.speaker} ${JSON.stringify(after.text.slice(0, 34))}`)
    })
  }
}
