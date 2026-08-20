import { describe, expect, it } from 'vitest'
import { joinTranscriptToTurns } from './attribute-recording'
import type { SpeakerTurn } from './diarize-sidecar'

const turn = (speaker: string, start_ms: number, end_ms: number): SpeakerTurn => ({
  speaker,
  start_ms,
  end_ms,
})

/** One word every 500 ms across a span, so a line has words to be made of. */
function words(from: number, to: number, step = 500) {
  const out: { text: string; start_ms: number; end_ms: number }[] = []
  for (let at = from; at + step <= to; at += step) {
    out.push({ text: `w${at}`, start_ms: at, end_ms: at + step - 50 })
  }
  return out
}

describe('turning a recording into attributed lines', () => {
  it('gives each line the speaker who was holding that stretch', () => {
    const run = joinTranscriptToTurns(
      words(0, 8_000),
      [turn('a', 0, 4_000), turn('b', 4_000, 8_000)],
      0,
    )
    expect(run.segments.map((segment) => segment.speaker)).toEqual(['a', 'b'])
    expect(run.speakerCount).toBe(2)
  })

  /**
   * The honest half of what pyannote buys. The previous pipeline inferred
   * crosstalk from how fast the segments alternated, which flagged clean
   * two-line turn-taking ("night, Clara." / "Good night.") as contested and
   * suppressed a correct answer. Overlap is now a reported fact.
   */
  it('marks a line that somebody else spoke across, and only that line', () => {
    const run = joinTranscriptToTurns(
      // Two lines, separated by a pause: the first clean, the second entirely
      // inside the stretch where b is talking over a.
      [...words(0, 4_000), ...words(6_000, 10_000)],
      [turn('a', 0, 10_000), turn('b', 6_000, 10_000)],
      4_000,
    )
    expect(run.segments.map((segment) => segment.confident)).toEqual([true, false])
    expect(run.contestedMs).toBeGreaterThan(0)
    expect(run.overlapMs).toBe(4_000)
  })

  it('leaves brisk clean turn-taking confident', () => {
    const run = joinTranscriptToTurns(
      [
        { text: 'night,', start_ms: 4_000, end_ms: 4_400 },
        { text: 'Clara.', start_ms: 4_450, end_ms: 4_900 },
        { text: 'Good', start_ms: 5_100, end_ms: 5_400 },
        { text: 'night.', start_ms: 5_450, end_ms: 5_900 },
      ],
      [turn('a', 3_900, 4_950), turn('b', 5_050, 6_000)],
      0,
    )
    expect(run.segments.map((segment) => [segment.speaker, segment.text])).toEqual([
      ['a', 'night, Clara.'],
      ['b', 'Good night.'],
    ])
    expect(run.segments.every((segment) => segment.confident)).toBe(true)
  })

  it('counts speech per speaker from their exclusive time, not from their turns', () => {
    // b talks across a for two seconds. That audio embeds as neither of them,
    // so it is not evidence of how much of either voice there is to identify.
    const run = joinTranscriptToTurns(
      words(0, 10_000),
      [turn('a', 0, 10_000), turn('b', 6_000, 8_000)],
      2_000,
    )
    expect(run.speechMsBySpeaker.get('a')).toBe(8_000)
    expect(run.speechMsBySpeaker.get('b')).toBe(0)
  })

  it('reports what share of the words it could put on a speaker', () => {
    const run = joinTranscriptToTurns(
      [...words(0, 4_000), { text: 'offstage', start_ms: 60_000, end_ms: 60_400 }],
      [turn('a', 0, 4_000)],
      0,
    )
    expect(run.totalWords).toBe(9)
    expect(run.attributedWords).toBe(8)
  })

  it('is not told how many people to expect', () => {
    const run = joinTranscriptToTurns(
      words(0, 12_000),
      [turn('a', 0, 4_000), turn('b', 4_000, 8_000), turn('c', 8_000, 12_000)],
      0,
    )
    expect(run.speakerCount).toBe(3)
  })
})
