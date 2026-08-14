import { describe, expect, it } from 'vitest'
import { StreamBuffer, UNKNOWN_SPEAKER } from './stream-buffer'
import { SAMPLE_RATE } from './types'

const buffer = () => new StreamBuffer('c1')

describe('word revision', () => {
  /**
   * The live-transcript corruption: partials re-time their words, so keying on
   * start_ms alone stacked each revision on the last instead of replacing it.
   */
  it('replaces a turn wholesale instead of interleaving its revisions', () => {
    const b = buffer()
    b.addSegments([{ speaker: 'turn-0', start_ms: 0, end_ms: 1000 }])

    b.addWords([{ text: 'how', start_ms: 0, end_ms: 500, turn: 'turn-0' }])
    b.addWords([
      { text: 'how', start_ms: 0, end_ms: 300, turn: 'turn-0' },
      { text: 'are', start_ms: 300, end_ms: 600, turn: 'turn-0' },
    ])
    b.addWords([
      { text: 'how', start_ms: 0, end_ms: 250, turn: 'turn-0' },
      { text: 'are', start_ms: 250, end_ms: 500, turn: 'turn-0' },
      { text: 'you', start_ms: 500, end_ms: 900, turn: 'turn-0' },
    ])

    expect(b.utterances()[0].text).toBe('how are you')
  })

  it('keeps turns independent when one is revised', () => {
    const b = buffer()
    b.addSegments([
      { speaker: 'turn-0', start_ms: 0, end_ms: 1000 },
      { speaker: 'turn-1', start_ms: 1000, end_ms: 2000 },
    ])
    b.addWords([{ text: 'hello', start_ms: 0, end_ms: 900, turn: 'turn-0' }])
    b.addWords([{ text: 'there', start_ms: 1000, end_ms: 1900, turn: 'turn-1' }])
    b.addWords([{ text: 'hi', start_ms: 0, end_ms: 900, turn: 'turn-0' }])

    expect(b.utterances().map((u) => u.text)).toEqual(['hi', 'there'])
  })

  it('still keys untagged words by start time, for providers that send no turn', () => {
    const b = buffer()
    b.addSegments([{ speaker: 'S0', start_ms: 0, end_ms: 1000 }])
    b.addWords([{ text: 'draft', start_ms: 0, end_ms: 500 }])
    b.addWords([{ text: 'final', start_ms: 0, end_ms: 500 }])

    expect(b.utterances()[0].text).toBe('final')
  })
})

describe('clock', () => {
  it('advances only with samples', () => {
    const b = buffer()
    expect(b.elapsedMs).toBe(0)
    b.pushAudio(new Float32Array(SAMPLE_RATE)) // one second
    expect(b.elapsedMs).toBe(1000)
    b.pushAudio(new Float32Array(1600)) // one 100 ms frame
    expect(b.elapsedMs).toBe(1100)
  })
})

describe('word to segment join', () => {
  it('attributes by midpoint containment', () => {
    const b = buffer()
    b.addSegments([
      { speaker: 'S0', start_ms: 0, end_ms: 1000 },
      { speaker: 'S1', start_ms: 1000, end_ms: 2000 },
    ])
    // Straddles the boundary but most of it is inside S1.
    expect(b.speakerFor({ text: 'hey', start_ms: 900, end_ms: 1400 })).toBe('S1')
    expect(b.speakerFor({ text: 'yo', start_ms: 100, end_ms: 300 })).toBe('S0')
    expect(b.speakerFor({ text: 'later', start_ms: 5000, end_ms: 5200 })).toBe(UNKNOWN_SPEAKER)
  })

  it('groups consecutive same-speaker words into utterances', () => {
    const b = buffer()
    b.addSegments([
      { speaker: 'S0', start_ms: 0, end_ms: 1000 },
      { speaker: 'S1', start_ms: 1000, end_ms: 2000 },
    ])
    b.addWords([
      { text: 'hello', start_ms: 0, end_ms: 400 },
      { text: 'there', start_ms: 450, end_ms: 900 },
      { text: 'hi', start_ms: 1100, end_ms: 1300 },
    ])
    const utterances = b.utterances()
    expect(utterances).toHaveLength(2)
    expect(utterances[0]).toMatchObject({ session_speaker: 'S0', text: 'hello there', start_ms: 0, end_ms: 900 })
    expect(utterances[1]).toMatchObject({ session_speaker: 'S1', text: 'hi' })
  })
})

describe('revisions', () => {
  it('replaces overlapping segments instead of stacking', () => {
    const b = buffer()
    b.addSegments([{ speaker: 'S0', start_ms: 0, end_ms: 2000 }])
    // Diarisation revises: the second half was actually another speaker.
    b.addSegments([
      { speaker: 'S0', start_ms: 0, end_ms: 1000 },
      { speaker: 'S1', start_ms: 1000, end_ms: 2000 },
    ])
    expect(b.speakerFor({ text: 'x', start_ms: 1500, end_ms: 1700 })).toBe('S1')
    expect(b.speechMsFor('S0')).toBe(1000)
  })

  it('replaces a re-emitted word by start time', () => {
    const b = buffer()
    b.addSegments([{ speaker: 'S0', start_ms: 0, end_ms: 1000 }])
    b.addWords([{ text: 'wrekcognise', start_ms: 0, end_ms: 500 }])
    b.addWords([{ text: 'recognise', start_ms: 0, end_ms: 500 }])
    expect(b.utterances()).toHaveLength(1)
    expect(b.utterances()[0].text).toBe('recognise')
  })

  it('preserves unaffected spans around a partial segment revision', () => {
    const b = buffer()
    b.addSegments([{ speaker: 'S0', start_ms: 0, end_ms: 3000 }])
    b.addSegments([{ speaker: 'S1', start_ms: 1000, end_ms: 2000 }])

    expect(b.speakerFor({ text: 'left', start_ms: 200, end_ms: 400 })).toBe('S0')
    expect(b.speakerFor({ text: 'middle', start_ms: 1200, end_ms: 1400 })).toBe('S1')
    expect(b.speakerFor({ text: 'right', start_ms: 2400, end_ms: 2600 })).toBe('S0')
    expect(b.speechMsFor('S0')).toBe(2000)
  })
})

describe('finalization', () => {
  it('holds back utterances still at the live edge', () => {
    const b = buffer()
    b.addSegments([
      { speaker: 'S0', start_ms: 0, end_ms: 1000 },
      { speaker: 'S1', start_ms: 1000, end_ms: 3000 },
    ])
    b.addWords([
      { text: 'done', start_ms: 0, end_ms: 900 },
      { text: 'still', start_ms: 1100, end_ms: 1500 },
      { text: 'talking', start_ms: 1600, end_ms: 2600 },
    ])
    const final = b.finalizedUtterances(1500)
    expect(final).toHaveLength(1)
    expect(final[0].text).toBe('done')
  })
})

describe('per-speaker audio', () => {
  it('slices and concatenates PCM by segment', () => {
    const b = buffer()
    // Two seconds of audio: first second is 0.25, second is 0.75.
    const first = new Float32Array(SAMPLE_RATE).fill(0.25)
    const second = new Float32Array(SAMPLE_RATE).fill(0.75)
    b.pushAudio(first)
    b.pushAudio(second)
    b.addSegments([
      { speaker: 'S0', start_ms: 0, end_ms: 1000 },
      { speaker: 'S1', start_ms: 1000, end_ms: 2000 },
      { speaker: 'S0', start_ms: 2000, end_ms: 2500 }, // beyond retained audio, clamps to nothing
    ])
    const s0 = b.audioFor('S0')
    expect(s0.length).toBe(SAMPLE_RATE)
    expect(s0[0]).toBeCloseTo(0.25)
    const s1 = b.audioFor('S1')
    expect(s1.length).toBe(SAMPLE_RATE)
    expect(s1[0]).toBeCloseTo(0.75)
  })

  it('reports speakers over the embedding floor', () => {
    const b = buffer()
    b.addSegments([
      { speaker: 'S0', start_ms: 0, end_ms: 3500 },
      { speaker: 'S1', start_ms: 3500, end_ms: 4000 },
    ])
    expect(b.speakersOverFloor(3000)).toEqual(['S0'])
  })
})
