import { describe, expect, it } from 'vitest'
import {
  bestPool,
  poolableStretches,
  rewriteTurns,
  sentencesFromWords,
  stretchesWithinBudget,
} from './sentence-pass'
import type { SpeakerTurn } from './diarize-sidecar'

const word = (text: string, start_ms: number, end_ms: number) => ({ text, start_ms, end_ms })

describe('sentencesFromWords', () => {
  it('breaks at terminal punctuation and keeps the words timings', () => {
    const sentences = sentencesFromWords([
      word('Where', 0, 100),
      word('from?', 100, 300),
      word('Boris.', 400, 900),
    ])
    expect(sentences).toEqual([
      { start_ms: 0, end_ms: 300, text: 'Where from?', terminated: true },
      { start_ms: 400, end_ms: 900, text: 'Boris.', terminated: true },
    ])
  })

  it('does not break on a decimal point or an abbreviation inside a word', () => {
    expect(sentencesFromWords([word('borisen.com', 0, 500), word('yes.', 500, 900)])).toHaveLength(1)
  })

  it('marks a trailing fragment that never terminates, so callers can refuse it', () => {
    expect(sentencesFromWords([word('and', 0, 100), word('then', 100, 200)])).toEqual([
      { start_ms: 0, end_ms: 200, text: 'and then', terminated: false },
    ])
  })

  it('marks the whole recording unterminated when punctuation is missing entirely', () => {
    // The case that matters: attributing this as one unit would assert that
    // every speaker in the recording is the same person.
    const sentences = sentencesFromWords([
      word('mine', 500, 2_000),
      word('still-mine', 2_500, 4_500),
      word('yours', 5_500, 7_000),
    ])
    expect(sentences).toHaveLength(1)
    expect(sentences[0].terminated).toBe(false)
  })

  it('returns nothing for no words rather than an empty sentence', () => {
    expect(sentencesFromWords([])).toEqual([])
  })
})

describe('poolableStretches', () => {
  const turns: SpeakerTurn[] = [
    { start_ms: 0, end_ms: 5_000, speaker: 'A' },
    { start_ms: 4_000, end_ms: 9_000, speaker: 'B' },
    { start_ms: 20_000, end_ms: 22_000, speaker: 'A' },
    { start_ms: 30_000, end_ms: 30_500, speaker: 'A' },
  ]

  it('drops turns another speaker talks across, because their voice is a blend', () => {
    const pools = poolableStretches(turns, 1_000)
    expect(pools.get('A')?.map((turn) => turn.start_ms)).toEqual([20_000])
    expect(pools.has('B')).toBe(false)
  })

  it('drops turns below the floor', () => {
    expect(poolableStretches(turns, 1_000).get('A')?.some((t) => t.start_ms === 30_000)).toBe(false)
  })

  it('offers the longest stretches first, so a budget spends on the best evidence', () => {
    const many: SpeakerTurn[] = [
      { start_ms: 0, end_ms: 2_000, speaker: 'A' },
      { start_ms: 10_000, end_ms: 18_000, speaker: 'A' },
    ]
    expect(poolableStretches(many, 1_000).get('A')?.map((t) => t.end_ms - t.start_ms)).toEqual([
      8_000, 2_000,
    ])
  })
})

describe('stretchesWithinBudget', () => {
  it('stops at the budget, clipping the turn that crosses it', () => {
    const taken = stretchesWithinBudget(
      [
        { start_ms: 0, end_ms: 30_000, speaker: 'A' },
        { start_ms: 60_000, end_ms: 90_000, speaker: 'A' },
      ],
      40_000,
    )
    expect(taken).toEqual([
      { start_ms: 0, end_ms: 30_000 },
      { start_ms: 60_000, end_ms: 70_000 },
    ])
  })
})

describe('bestPool', () => {
  it('picks the most similar voice regardless of vector magnitude', () => {
    const pools = new Map([
      ['A', [10, 0, 0]],
      ['B', [0, 1, 0]],
    ])
    expect(bestPool([1, 0, 0], pools)).toBe('A')
    expect(bestPool([0, 5, 0], pools)).toBe('B')
  })

  it('returns null when there is nothing to compare against', () => {
    expect(bestPool([1, 0, 0], new Map())).toBeNull()
  })
})

describe('rewriteTurns', () => {
  const turns: SpeakerTurn[] = [{ start_ms: 0, end_ms: 10_000, speaker: 'A' }]

  it('gives an attributed sentence its own speaker', () => {
    const out = rewriteTurns(turns, [{ start_ms: 4_000, end_ms: 6_000, speaker: 'B' }])
    expect(out).toContainEqual({ start_ms: 4_000, end_ms: 6_000, speaker: 'B' })
  })

  it('keeps the diarizer answer either side, so no speech loses its speaker', () => {
    const out = rewriteTurns(turns, [{ start_ms: 4_000, end_ms: 6_000, speaker: 'B' }])
    expect(out).toContainEqual({ start_ms: 0, end_ms: 4_000, speaker: 'A' })
    expect(out).toContainEqual({ start_ms: 6_000, end_ms: 10_000, speaker: 'A' })
    const covered = out.reduce((sum, turn) => sum + (turn.end_ms - turn.start_ms), 0)
    expect(covered).toBe(10_000)
  })

  it('leaves untouched time exactly as it was', () => {
    expect(rewriteTurns(turns, [])).toEqual(turns)
  })

  it('returns turns in time order', () => {
    const out = rewriteTurns(turns, [
      { start_ms: 7_000, end_ms: 8_000, speaker: 'C' },
      { start_ms: 1_000, end_ms: 2_000, speaker: 'B' },
    ])
    expect(out.map((turn) => turn.start_ms)).toEqual([...out.map((t) => t.start_ms)].sort((a, b) => a - b))
  })
})
