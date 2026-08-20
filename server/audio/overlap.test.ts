import { describe, expect, it } from 'vitest'
import type { SpeakerTurn } from './diarize-sidecar'
import { exclusiveTurns, inOverlap, overlapRegions, totalMs } from './overlap'

const turn = (speaker: string, start_ms: number, end_ms: number): SpeakerTurn => ({
  speaker,
  start_ms,
  end_ms,
})

describe('overlapRegions', () => {
  it('finds nothing in clean turn-taking, however tightly packed', () => {
    expect(overlapRegions([turn('a', 0, 5_000), turn('b', 5_000, 9_000)])).toEqual([])
  })

  it('finds the stretch two people hold at once', () => {
    expect(overlapRegions([turn('a', 0, 5_000), turn('b', 3_000, 8_000)])).toEqual([
      { start_ms: 3_000, end_ms: 5_000 },
    ])
  })

  it('does not count one speaker against themselves', () => {
    // A speaker's own turns can abut or nest; that is not two people talking.
    expect(overlapRegions([turn('a', 0, 5_000), turn('a', 2_000, 8_000)])).toEqual([])
  })

  it('closes the region when the room drops back to one voice', () => {
    const regions = overlapRegions([turn('a', 0, 10_000), turn('b', 2_000, 3_000), turn('c', 6_000, 7_000)])
    expect(regions).toEqual([
      { start_ms: 2_000, end_ms: 3_000 },
      { start_ms: 6_000, end_ms: 7_000 },
    ])
  })

  it('answers whether a given span touches one', () => {
    const regions = overlapRegions([turn('a', 0, 5_000), turn('b', 3_000, 8_000)])
    expect(inOverlap(regions, 3_500, 4_000)).toBe(true)
    expect(inOverlap(regions, 6_000, 6_500)).toBe(false)
  })
})

describe('exclusiveTurns', () => {
  /**
   * The reason this exists: audio where two people talk at once embeds as
   * neither of them, and a pooled print built from it is a blend. Blends were
   * the whole failure of the pipeline this replaced.
   */
  it('cuts the part somebody else was talking over out of a turn', () => {
    const exclusive = exclusiveTurns([turn('a', 0, 10_000), turn('b', 4_000, 6_000)])
    expect(exclusive.filter((piece) => piece.speaker === 'a')).toEqual([
      { speaker: 'a', start_ms: 0, end_ms: 4_000 },
      { speaker: 'a', start_ms: 6_000, end_ms: 10_000 },
    ])
    expect(exclusive.filter((piece) => piece.speaker === 'b')).toEqual([])
  })

  it('leaves clean turns untouched', () => {
    const turns = [turn('a', 0, 5_000), turn('b', 5_000, 9_000)]
    expect(exclusiveTurns(turns)).toEqual(turns)
  })

  it('drops a turn that was spoken over from end to end', () => {
    expect(exclusiveTurns([turn('a', 0, 10_000), turn('b', 2_000, 3_000)]).map((p) => p.speaker)).toEqual([
      'a',
      'a',
    ])
  })

  it('totals only what is left', () => {
    expect(totalMs(exclusiveTurns([turn('a', 0, 10_000), turn('b', 4_000, 6_000)]))).toBe(8_000)
  })
})

describe('a word with no duration', () => {
  const regions = [{ start_ms: 1000, end_ms: 2000 }]

  /**
   * Whisper gives about 9% of its words an end equal to their start. Answering
   * "not overlapped" for those reads missing duration as evidence of nothing
   * happening, and they are the words with the least timing to stand on.
   */
  it('is contested when it lands inside simultaneous speech', () => {
    expect(inOverlap(regions, 1500, 1500)).toBe(true)
  })

  it('is not contested on the boundary, which is a handover and not crosstalk', () => {
    expect(inOverlap(regions, 1000, 1000)).toBe(false)
    expect(inOverlap(regions, 2000, 2000)).toBe(false)
  })

  it('is not contested outside a region at all', () => {
    expect(inOverlap(regions, 900, 900)).toBe(false)
    expect(inOverlap(regions, 2100, 2100)).toBe(false)
  })
})
