import { describe, expect, it } from 'vitest'
import { hasRealFixture, readRealFixture } from '../../fixtures/real-audio'
import { restorePunctuation } from './punctuation'
import { readTimedTranscript, type WhisperResponse } from './whisper-client'

const timed = (text: string, start_ms: number) => ({ text, start_ms, end_ms: start_ms + 100 })
const stream = (words: string) => words.split(' ').map((word, index) => timed(word, index * 200))

describe('restoring punctuation onto timed words', () => {
  it('takes the punctuation and the capitalisation from the segment', () => {
    const out = restorePunctuation(stream('yo guys what up you boris'), [
      { start_ms: 0, end_ms: 1200, text: ' Yo guys, what up, you Boris?' },
    ])
    expect(out.map((word) => word.text).join(' ')).toBe('Yo guys, what up, you Boris?')
  })

  it('leaves the timings exactly as they arrived', () => {
    const words = stream('i am boris')
    const out = restorePunctuation(words, [{ start_ms: 0, end_ms: 600, text: 'I am Boris.' }])
    expect(out.map((word) => [word.start_ms, word.end_ms])).toEqual(
      words.map((word) => [word.start_ms, word.end_ms]),
    )
  })

  /**
   * The failure this module exists to never cause. A run-on transcript is
   * readable; a transcript missing a sentence is not detectably wrong at all,
   * so no disagreement between the two views may cost a word.
   */
  it('keeps every word, in order, when the segment text disagrees', () => {
    const words = stream('i said twenty three of them um yesterday')
    const out = restorePunctuation(words, [
      { start_ms: 0, end_ms: 1400, text: 'I said 23 of them, yesterday.' },
    ])
    expect(out.length).toBe(words.length)
    expect(out.map((word) => word.text.replace(/[.,]/g, '').toLowerCase())).toEqual(
      words.map((word) => word.text),
    )
  })

  it('punctuates around a word it could not match, leaving that word alone', () => {
    const words = stream('i said twenty three of them um yesterday and that was it')
    const out = restorePunctuation(words, [
      { start_ms: 0, end_ms: 2400, text: 'I said 23 of them, yesterday, and that was it.' },
    ])
    expect(out.map((word) => word.text).join(' ')).toBe(
      'I said twenty three of them, um yesterday, and that was it.',
    )
  })

  it('applies nothing at all when the two views are describing different audio', () => {
    const words = stream('one two three four five six')
    const out = restorePunctuation(words, [
      { start_ms: 0, end_ms: 1200, text: 'Completely different words, entirely.' },
    ])
    expect(out).toEqual(words)
  })

  it('survives a transcript with no segments and segments with no words', () => {
    expect(restorePunctuation(stream('a b'), [])).toEqual(stream('a b'))
    expect(restorePunctuation([], [{ start_ms: 0, end_ms: 10, text: 'Hello.' }])).toEqual([])
  })

  it('does not reorder words when a segment repeats a token', () => {
    const out = restorePunctuation(stream('boris boris nice to meet you'), [
      { start_ms: 0, end_ms: 1200, text: 'Boris. Boris. Nice to meet you.' },
    ])
    expect(out.map((word) => word.text)).toEqual(['Boris.', 'Boris.', 'Nice', 'to', 'meet', 'you.'])
  })
})

/**
 * The real recording is the only place the awkward cases actually live —
 * whisper dropping a token from one view and not the other, contractions, a
 * chunk seam landing mid-sentence. Measured here rather than asserted from a
 * hand-written fixture, which would only ever agree with itself.
 */
describe('on the real recordings', () => {
  for (const stem of ['dorm-40min', 'dorm-9pm']) {
    const fixture = `${stem}.whisper.json`
    const it_ = hasRealFixture(fixture) ? it : it.skip
    it_(`${stem}: loses no word and punctuates nearly all of them`, () => {
      const raw = readRealFixture<WhisperResponse>(fixture)
      const before = (raw.words ?? []).map((word) => (word.word ?? '').trim())
      const after = readTimedTranscript(raw).words

      expect(after.length).toBe(before.length)
      const bare = (text: string) => text.replace(/[^\p{L}\p{N}']/gu, '').toLowerCase()
      expect(after.map((word) => bare(word.text))).toEqual(before.map(bare))
      // 98% of words aligned on both recordings when this was written; the
      // assertion is loose because the number belongs to whisper's output, not
      // to this code, and a re-transcription would move it.
      const punctuated = after.filter((word, index) => word.text !== before[index]).length
      expect(punctuated / after.length).toBeGreaterThan(0.25)
    })
  }
})
