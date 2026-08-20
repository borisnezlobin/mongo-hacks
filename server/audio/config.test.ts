import { describe, expect, it } from 'vitest'
import { EMBED_MIN_MS, PROVISIONAL_SPEECH_MS } from '../../shared/contracts'
import { configNotes, readAudioConfig } from './config'

describe('audio config', () => {
  it('uses the measured contract values when nothing overrides them', () => {
    const config = readAudioConfig({})

    expect(config.embedMinMs).toBe(EMBED_MIN_MS)
    expect(config.provisionalSpeechMs).toBe(PROVISIONAL_SPEECH_MS)
  })

  /**
   * server/.env carried EMBED_MIN_MS=1600, which put every identification in
   * the measured ~27% equal-error zone, and nothing anywhere said so.
   */
  it('refuses an override that loosens a measured floor, and says why', () => {
    const config = readAudioConfig({ EMBED_MIN_MS: '1600' })

    expect(config.embedMinMs).toBe(EMBED_MIN_MS)
    expect(configNotes().join(' ')).toContain('below the measured floor')
  })

  it('accepts a stricter override and announces it', () => {
    const config = readAudioConfig({ EMBED_MIN_MS: '5000' })

    expect(config.embedMinMs).toBe(5_000)
    expect(configNotes().join(' ')).toContain('overrides the measured')
  })

  it('ignores a value that is not a number rather than producing NaN', () => {
    expect(readAudioConfig({ EMBED_MIN_MS: 'yes' }).embedMinMs).toBe(EMBED_MIN_MS)
  })

  it('treats retention and the final pass as switchable', () => {
    expect(readAudioConfig({ AUDIO_RETAIN: 'off' }).retainEnabled).toBe(false)
    expect(readAudioConfig({ AUDIO_FINAL_PASS: '0' }).finalPassEnabled).toBe(false)
    expect(readAudioConfig({}).retainEnabled).toBe(true)
  })
})

describe('retention cap', () => {
  it('is long enough for the recordings people actually make', () => {
    // The owner's first real conversation is 2,901,950 ms. The old default was
    // 45 minutes, so the very first genuine use of this product would have
    // silently lost its last three minutes.
    expect(readAudioConfig({}).retainMaxMs).toBeGreaterThan(2_901_950)
  })

  it('stays overridable for a machine with less disk', () => {
    expect(readAudioConfig({ AUDIO_RETAIN_MAX_MS: '600000' }).retainMaxMs).toBe(600_000)
  })
})

describe('ASR vocabulary biasing', () => {
  it('is off unless asked for, because it was measured to delete 15% of the words', () => {
    expect(readAudioConfig({}).vocabularyEnabled).toBe(false)
    expect(readAudioConfig({ AUDIO_ASR_VOCABULARY: '1' }).vocabularyEnabled).toBe(true)
  })
})
