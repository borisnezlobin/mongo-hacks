/**
 * Which label each landmark quote actually lands on.
 *
 * The merge and split counts say whether two landmarks collide. They cannot say
 * WHERE a landmark went, and the difference decides whether a change is a fix.
 * A negative landmark -- "M-A-R-T is not Vova" -- is silenced just as well by
 * moving the line onto a third person's label as by putting it on Mert, and the
 * count reads as an improvement either way.
 *
 * That is not hypothetical. A sentence-level re-segmentation measured 6 merges
 * down to 4 on dorm-40min; this table showed M-A-R-T had moved from Vova's
 * label to Boris's, and "can I rip a seat?" onto a label no landmark occupies.
 * None of the three owner-confirmed errors was fixed. Read this before
 * believing a merge count that went down.
 *
 * How big the unwatched area is, from eval/real/blind-spots.mts:
 *
 *                              dorm-40min        dorm-9pm
 *   labels with no landmark    3 of 8, 66% of    1 of 4, 11% of
 *                              diarized speech   diarized speech
 *   people scored / in room    3 of 7            3 of 3
 *   speech labelled            39% of diarized   93% of diarized
 *   person pairs discriminable 6 of 21 (29%)     3 of 3 (100%)
 *
 * So on dorm-40min most of the recording is somewhere neither the landmarks nor
 * DER is looking, and dorm-9pm is the more honest test despite being smaller.
 *
 * For the part this table cannot see, and for jerry-45min and mentra-mtg which
 * have no landmarks at all, use eval/real/dialogue_probe.py. A label holding
 * both a question and the reply to it is holding two people, which the
 * transcript settles on its own -- no reference, no threshold, no voiceprint,
 * and no blind spot, because it watches every label rather than the ones a
 * landmark happens to occupy. Today's rates: dorm-9pm 44%, dorm-40min 70%,
 * jerry-45min 82%, mentra-mtg 85%.
 *
 *   npx tsx eval/real/landmark-labels.mts [candidate-diarization.json]
 */

import { readFileSync } from 'node:fs'
import { joinWordsToSpeakers } from '../../server/audio/word-join'
import type { SpeakerTurn } from '../../server/audio/diarize-sidecar'
import { readTimedTranscript, type WhisperResponse } from '../../server/audio/whisper-client'
import { readRealFixture } from '../../fixtures/real-audio'
import { LANDMARKS } from '../landmarks'

const stem = 'dorm-40min'
const transcript = readTimedTranscript(readRealFixture<WhisperResponse>(`${stem}.whisper.json`))
// A candidate diarization can be passed as an argument, so a proposed pipeline
// is read through the same table as the shipped one without overwriting the
// fixture the shipped numbers are measured against.
const candidate = process.argv[2]
const turns = candidate
  ? (JSON.parse(readFileSync(candidate, 'utf8')) as { turns: SpeakerTurn[] }).turns
  : readRealFixture<{ turns: SpeakerTurn[] }>(`${stem}.pyannote.json`).turns
const marks = LANDMARKS.filter((mark) => mark.recording === stem)

const lines = joinWordsToSpeakers(transcript.words, turns, { segments: transcript.segments })
const landed = marks.map((mark) => {
  let best: { speaker: string | null; shared: number } | null = null
  for (const line of lines) {
    const shared = Math.min(mark.end_ms, line.end_ms) - Math.max(mark.at_ms, line.start_ms)
    if (shared > 0 && (!best || shared > best.shared)) best = { speaker: line.speaker, shared }
  }
  return best?.speaker ?? null
})

console.log('quote'.padEnd(46) + 'claim'.padEnd(18) + 'lands on')
for (const [index, mark] of marks.entries()) {
  const claim = mark.person ? `is ${mark.person}` : `is NOT ${mark.notPerson}`
  console.log(mark.quote.slice(0, 44).padEnd(46) + claim.padEnd(18) + String(landed[index]))
}
