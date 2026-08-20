import { describe, expect, it } from 'vitest'
import type { SpeakerTurn } from './diarize-sidecar'
import { joinWordsToSpeakers, SNAP_MS, speakerForSpan, speechMsBySpeaker } from './word-join'

const turn = (speaker: string, start_ms: number, end_ms: number): SpeakerTurn => ({
  speaker,
  start_ms,
  end_ms,
})

const word = (text: string, start_ms: number, end_ms: number) => ({ text, start_ms, end_ms })

describe('speakerForSpan', () => {
  const turns = [turn('A', 0, 5_000), turn('B', 5_000, 10_000)]

  it('gives the word to whoever holds most of it', () => {
    expect(speakerForSpan(turns, 4_600, 5_200)).toBe('A')
    expect(speakerForSpan(turns, 4_800, 5_600)).toBe('B')
  })

  it('reaches to the nearest turn when the word lands in no turn at all', () => {
    // The disagreement the snap exists for: whisper starts the word before
    // pyannote starts the speaker.
    expect(speakerForSpan([turn('A', 1_000, 5_000)], 700, 950)).toBe('A')
  })

  it('leaves a word in real silence unattributed rather than guessing', () => {
    const far = SNAP_MS + 200
    expect(speakerForSpan([turn('A', 10_000, 15_000)], 10_000 - far - 300, 10_000 - far)).toBeNull()
  })

  it('prefers the closer turn when it could snap to either side', () => {
    const gapped = [turn('A', 0, 1_000), turn('B', 1_300, 5_000)]
    expect(speakerForSpan(gapped, 1_050, 1_150)).toBe('A')
    expect(speakerForSpan(gapped, 1_150, 1_250)).toBe('B')
  })

  /**
   * A word inside an interjection lies fully in both turns, so overlap ties and
   * whoever had the floor keeps it. Preferring the tighter-fitting turn instead
   * was measured on both real recordings: no landmark verdict moved, unexplained
   * speech rose, and the line count more than doubled. See speakerForSpan.
   */
  it('gives a word spoken across somebody to whoever cut in, not the floor-holder', () => {
    // The failure this exists to prevent: a long turn absorbing everything said
    // across it. On the owner's recording a 19-second turn swallowed a
    // 24-second stretch containing three people, including the owner stating
    // his own major, and credited all of it to one speaker.
    const crosstalk = [turn('floor', 0, 24_000), turn('cutting-in', 8_000, 8_800)]
    expect(speakerForSpan(crosstalk, 8_100, 8_600)).toBe('cutting-in')
  })

  it('still gives an uncontested word to the only turn covering it', () => {
    expect(speakerForSpan([turn('floor', 0, 24_000)], 8_100, 8_600)).toBe('floor')
  })
})

describe('joinWordsToSpeakers', () => {
  it('cuts a line where the speaker changes, not where the words happen to pause', () => {
    // Three words a side, so the change survives smoothing: a real turn lasts
    // longer than its neighbourhood, which is exactly what separates it from
    // the per-word flicker smoothing exists to remove.
    const lines = joinWordsToSpeakers(
      [
        word('who', 100, 600), word('said', 700, 1_200), word('that', 1_300, 1_800),
        word('and', 5_200, 5_800), word('then', 5_900, 6_400), word('though', 6_500, 7_000),
      ],
      [turn('A', 0, 5_000), turn('B', 5_000, 10_000)],
    )
    expect(lines.map((line) => [line.speaker, line.text])).toEqual([
      ['A', 'who said that'],
      ['B', 'and then though'],
    ])
  })

  it('splits a whisper segment that spans a speaker change', () => {
    // The reason the join is at word level. Attributing this whole run to one
    // speaker hands four of the eight words to the wrong person.
    const words = Array.from({ length: 8 }, (_, index) => word(`w${index}`, index * 1_000, index * 1_000 + 800))
    const lines = joinWordsToSpeakers(words, [turn('A', 0, 4_000), turn('B', 4_000, 9_000)])
    expect(lines).toHaveLength(2)
    expect(lines[0].words.map((w) => w.text)).toEqual(['w0', 'w1', 'w2', 'w3'])
    expect(lines[1].words.map((w) => w.text)).toEqual(['w4', 'w5', 'w6', 'w7'])
  })

  it('keeps one speaker on one line across an ordinary breath', () => {
    const lines = joinWordsToSpeakers(
      [word('so', 0, 400), word('anyway', 1_500, 2_000)],
      [turn('A', 0, 5_000)],
    )
    expect(lines).toHaveLength(1)
  })

  it('starts a new line when the same speaker stops for longer than the gap', () => {
    const lines = joinWordsToSpeakers(
      [word('so', 0, 400), word('anyway', 3_000, 3_400)],
      [turn('A', 0, 5_000)],
    )
    expect(lines).toHaveLength(2)
    expect(lines.every((line) => line.speaker === 'A')).toBe(true)
  })

  /**
   * The confetti case. Without the snap these five words become five lines,
   * four of them anonymous, because whisper opens the turn 150 ms before
   * pyannote does and closes it 150 ms after.
   */
  it('does not shatter a turn over a boundary disagreement of a few hundred ms', () => {
    const words = [
      word('the', 850, 1_000),
      word('boundaries', 1_050, 1_600),
      word('never', 1_650, 2_100),
      word('line', 2_150, 2_600),
      word('up', 2_650, 3_150),
    ]
    const turns = [turn('A', 1_000, 3_000), turn('B', 20_000, 21_000)]
    expect(joinWordsToSpeakers(words, turns)).toHaveLength(1)
    // Without the tolerance the words outside the turn find nobody, so the line
    // breaks apart around them.
    const unsnapped = joinWordsToSpeakers(words, turns, { snapMs: 0 })
    expect(unsnapped.length).toBeGreaterThan(1)
  })

  it('keeps words nobody was heard speaking, without a speaker on them', () => {
    const lines = joinWordsToSpeakers(
      [word('offstage', 30_000, 30_500), word('mumble', 30_600, 31_000)],
      [turn('A', 0, 5_000)],
    )
    expect(lines).toEqual([
      expect.objectContaining({ speaker: null, text: 'offstage mumble' }),
    ])
  })

  it('marks a line spoken across somebody else, so a caller can hedge it', () => {
    const lines = joinWordsToSpeakers(
      [word('talking', 3_100, 3_600), word('over', 3_700, 4_200)],
      [turn('A', 0, 5_000), turn('B', 3_000, 8_000)],
    )
    expect(lines[0].overlapped).toBe(true)
    expect(lines[0].overlappedWords).toBe(2)
  })

  /**
   * Two consecutive turns share an instant at their boundary, and a word
   * straddling it touches both without anybody talking over anybody. Reading
   * that as crosstalk flagged 80% of a three-minute recording when 14 seconds
   * of it was simultaneous.
   */
  it('does not call an ordinary turn boundary crosstalk', () => {
    const lines = joinWordsToSpeakers(
      [word('handing', 4_800, 5_200), word('over', 5_300, 5_700)],
      [turn('A', 0, 5_000), turn('B', 5_000, 9_000)],
    )
    expect(lines.every((line) => !line.overlapped)).toBe(true)
  })

  /**
   * A line is several seconds long and one interjection touches it. Hedging on
   * any overlapped word puts more than half a transcript out of extraction's
   * reach to protect a tenth of it.
   */
  it('does not hedge a line that is mostly clean', () => {
    const lines = joinWordsToSpeakers(
      [word('one', 0, 500), word('two', 600, 1_100), word('three', 1_200, 1_700), word('four', 3_100, 3_400)],
      // B cuts in over the tail of "four" without taking it: A still holds most
      // of that word.
      [turn('A', 0, 5_000), turn('B', 3_350, 4_800)],
    )
    expect(lines[0].words).toHaveLength(4)
    expect(lines[0].overlappedWords).toBe(1)
    expect(lines[0].overlapped).toBe(false)
  })

  /**
   * The end of a question, taken back off the person who answered it.
   *
   * This is the dorm-9pm shape: somebody asks "Also, Josh, ... at the Steam
   * Union?" and Josh answers. pyannote hears Josh start before the question
   * finishes, so its last words are contested and the shorter turn wins them,
   * which splits one question across two people. The clean words of the same
   * sentence all name the asker, and they settle it.
   */
  it('gives a contested word to whoever owns the clean part of its sentence', () => {
    const words = [
      word('do', 1_000, 1_400),
      word('you', 1_500, 1_900),
      word('want', 2_000, 2_400),
      word('to', 3_100, 3_500),
      word('go?', 3_600, 3_900),
    ]
    const turns = [turn('asker', 0, 4_000), turn('answerer', 3_000, 6_000)]
    const windowed = joinWordsToSpeakers(words, turns)
    expect(windowed.map((line) => line.speaker)).toEqual(['asker', 'answerer'])

    const bySentence = joinWordsToSpeakers(words, turns, {
      segments: [{ start_ms: 1_000, end_ms: 3_900 }],
    })
    expect(bySentence).toEqual([
      expect.objectContaining({ speaker: 'asker', text: 'do you want to go?' }),
    ])
  })

  /**
   * A whisper sentence routinely spans a real speaker change, and when it does
   * it knows nothing about who owns its contested words. It must say so rather
   * than hand the whole sentence to whoever spoke first, which is the segment
   * level attribution this whole file exists to avoid.
   */
  it('says nothing when a sentence spans a speaker change', () => {
    const words = [
      word('mine', 500, 900),
      word('too', 1_000, 1_400),
      word('shared', 3_100, 3_500),
      word('yours', 4_200, 4_600),
      word('also', 4_700, 5_100),
    ]
    const turns = [turn('A', 0, 4_000), turn('B', 3_000, 7_000)]
    const sentence = [{ start_ms: 500, end_ms: 5_100 }]
    expect(joinWordsToSpeakers(words, turns, { segments: sentence }).map((line) => line.speaker)).toEqual(
      joinWordsToSpeakers(words, turns).map((line) => line.speaker),
    )
  })

  /**
   * Sentences are a neighbourhood for contested words and never a unit of
   * attribution. Speech nobody talked over keeps the speaker the audio gave it,
   * whatever the rest of its sentence says.
   */
  it('never moves a word nobody talked over', () => {
    const words = [word('hello', 500, 900), word('this', 5_200, 5_600), word('is', 5_700, 6_100)]
    const turns = [turn('A', 0, 4_000), turn('B', 5_000, 6_500)]
    const lines = joinWordsToSpeakers(words, turns, { segments: [{ start_ms: 500, end_ms: 6_100 }] })
    expect(lines.map((line) => line.speaker)).toEqual(['A', 'B'])
  })

  it('reads words in time order however they arrive', () => {
    const lines = joinWordsToSpeakers(
      [word('second', 2_000, 2_400), word('first', 100, 500)],
      [turn('A', 0, 5_000)],
    )
    expect(lines[0].text).toBe('first second')
  })
})

describe('speechMsBySpeaker', () => {
  it('totals each speaker across their turns', () => {
    const totals = speechMsBySpeaker([turn('A', 0, 5_000), turn('B', 5_000, 6_000), turn('A', 7_000, 9_000)])
    expect(totals.get('A')).toBe(7_000)
    expect(totals.get('B')).toBe(1_000)
  })
})
