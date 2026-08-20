/**
 * Turning a whole recording into attributed lines, from inputs already in hand.
 *
 * This is the seam evaluation scores, and it is deliberately the cheap half:
 * whisper's words are a real bill and pyannote's turns are 1.2x realtime on
 * CPU, so both are produced once and saved, and everything downstream of them
 * is arithmetic that can be re-run on every change. A measurement that has to
 * regenerate its inputs is a measurement nobody repeats.
 *
 * What used to be here was chunked provider diarization, a voiceprint stitch to
 * put the chunk labels back together, and a heuristic that inferred crosstalk
 * from rapid alternation. All three were reconstructions of things pyannote
 * does properly: it segments the whole file at once, so labels never need
 * stitching, and it reports simultaneous speech directly, so overlap never
 * needs inferring from the shape of the segments around it.
 */

import type { SpeakerTurn } from './diarize-sidecar'
import { joinWordsToSpeakers, speechMsBySpeaker, type TranscriptSegment } from './word-join'
import { exclusiveTurns } from './overlap'

export interface AttributedSegment {
  /** Diarized speaker: one label per person for the whole recording. */
  speaker: string
  text: string
  start_ms: number
  end_ms: number
  /**
   * False when somebody else was speaking across this line.
   *
   * A line spoken over another line has no single certain speaker, and
   * asserting one is what files one person's sentence under another person's
   * name. Callers should render these hedged and identity should not enrol from
   * them. Unlike the heuristic this replaced, it is not inferred from how
   * quickly the segments alternate — pyannote says so.
   */
  confident: boolean
}

export interface AttributionRun {
  segments: AttributedSegment[]
  /** Read off the data. Nothing here is told how many people to expect. */
  speakerCount: number
  speechMsBySpeaker: Map<string, number>
  /** Speech in lines marked not confident. */
  contestedMs: number
  totalSpeechMs: number
  /** Speech with two or more people talking at once, as the diarizer heard it. */
  overlapMs: number
  /** Words the join could put on a speaker, out of all the words whisper found. */
  attributedWords: number
  totalWords: number
}

export function joinTranscriptToTurns(
  words: readonly { text: string; start_ms: number; end_ms: number }[],
  turns: readonly SpeakerTurn[],
  overlapMs: number,
  /**
   * Whisper's sentence boundaries, where the caller has them.
   *
   * Optional because the join works without them and several callers hold only
   * words. They are worth passing: the join uses them to decide who owns a word
   * spoken while two people were talking, which a window over neighbouring
   * words gets wrong at the end of a sentence. See smoothSpeakers.
   */
  sentences: readonly TranscriptSegment[] = [],
): AttributionRun {
  const lines = joinWordsToSpeakers(words, turns, { segments: sentences })
  const segments: AttributedSegment[] = lines
    .filter((line) => line.speaker !== null)
    .map((line) => ({
      speaker: line.speaker as string,
      text: line.text,
      start_ms: line.start_ms,
      end_ms: line.end_ms,
      confident: !line.overlapped,
    }))

  let contestedMs = 0
  let totalSpeechMs = 0
  for (const segment of segments) {
    const ms = segment.end_ms - segment.start_ms
    totalSpeechMs += ms
    if (!segment.confident) contestedMs += ms
  }
  // Speech per person is read off the diarization, not off the lines: a person
  // who is spoken over still spoke, and their exclusive speech is what decides
  // whether there is enough of them to identify.
  const speech = speechMsBySpeaker(exclusiveTurns(turns))
  // Somebody whose every word was spoken over holds zero exclusive speech.
  // They are still in the room, and a missing key would read as "no such
  // speaker" rather than "nothing of them we can safely embed".
  for (const turn of turns) if (!speech.has(turn.speaker)) speech.set(turn.speaker, 0)

  return {
    segments,
    speakerCount: new Set(turns.map((turn) => turn.speaker)).size,
    speechMsBySpeaker: new Map([...speech].sort((a, b) => b[1] - a[1])),
    contestedMs,
    totalSpeechMs,
    overlapMs,
    attributedWords: lines
      .filter((line) => line.speaker !== null)
      .reduce((total, line) => total + line.words.length, 0),
    totalWords: words.length,
  }
}
