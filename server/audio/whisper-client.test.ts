import { describe, expect, it } from 'vitest'
import { planChunks, vocabularyPrompt, VOCABULARY_MAX_TERMS } from './whisper-client'
import { SAMPLE_RATE } from './types'

describe('vocabularyPrompt', () => {
  it('names the terms it wants whisper to hear', () => {
    expect(vocabularyPrompt(['Alara', 'Vova'])).toContain('Alara, Vova')
  })

  it('says nothing at all when there is nothing to bias toward', () => {
    expect(vocabularyPrompt([])).toBe('')
    expect(vocabularyPrompt(['  ', ''])).toBe('')
  })

  it('does not repeat a term, since every term is a word whisper may insert', () => {
    expect(vocabularyPrompt(['Vova', 'Vova'])).toBe(vocabularyPrompt(['Vova']))
  })

  it('caps the vocabulary, because the prompt is capped near 224 tokens', () => {
    expect(VOCABULARY_MAX_TERMS).toBeLessThanOrEqual(24)
  })
})

describe('a recording too big to upload', () => {
  /**
   * whisper's upload cap is 25 MB, which at 16 kHz mono 16-bit is thirteen
   * minutes. The first real conversation this product recorded was forty-eight,
   * so sending the file whole — which this used to do — fails outright on
   * exactly the recordings whose speakers are worth the most.
   */
  it('cuts it into pieces that each fit', () => {
    const twentyMinutes = new Float32Array(SAMPLE_RATE * 20 * 60)
    const spans = planChunks(twentyMinutes)
    expect(spans.length).toBeGreaterThan(1)
    for (const span of spans) expect((span.to - span.from) * 2 + 44).toBeLessThanOrEqual(24 * 1024 * 1024)
  })

  it('tiles the recording exactly, so no audio falls between the pieces', () => {
    const spans = planChunks(new Float32Array(SAMPLE_RATE * 20 * 60))
    expect(spans[0].from).toBe(0)
    expect(spans[spans.length - 1].to).toBe(SAMPLE_RATE * 20 * 60)
    for (let i = 1; i < spans.length; i += 1) expect(spans[i].from).toBe(spans[i - 1].to)
  })

  it('leaves a recording that already fits in one piece', () => {
    expect(planChunks(new Float32Array(SAMPLE_RATE * 60))).toHaveLength(1)
  })

  /**
   * A seam through the middle of a word loses it from both sides, so the cut
   * goes to the quietest moment in the run-up to the limit rather than to the
   * byte limit itself.
   */
  it('cuts where the room is quiet rather than at the byte limit', () => {
    const samples = new Float32Array(SAMPLE_RATE * 60)
    for (let i = 0; i < samples.length; i += 1) samples[i] = Math.sin(i * 0.05) * 0.5
    const silenceAt = SAMPLE_RATE * 25
    samples.fill(0, silenceAt, silenceAt + SAMPLE_RATE)

    // A cap that puts the hard limit at 30 s, with the silence inside the
    // seam-search window that precedes it.
    const [first] = planChunks(samples, SAMPLE_RATE * 30 * 2 + 44)
    expect(first.to).toBeGreaterThan(silenceAt)
    expect(first.to).toBeLessThan(silenceAt + SAMPLE_RATE)
  })
})
