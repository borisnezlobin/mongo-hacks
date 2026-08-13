import { describe, expect, it, vi } from 'vitest'
import { AmeliaBus } from '../lib/bus'
import { AudioSession } from './session'
import type { Segment, StreamProvider, Word } from './types'

class FlushProvider implements StreamProvider {
  private segments: (segments: Segment[]) => void = () => {}
  private words: (words: Word[]) => void = () => {}

  pushAudio(): void {}
  onSegments(handler: (segments: Segment[]) => void): void { this.segments = handler }
  onWords(handler: (words: Word[]) => void): void { this.words = handler }
  async close(): Promise<void> {
    this.segments([{ speaker: 'S0', start_ms: 0, end_ms: 500 }])
    this.words([{ text: 'flushed', start_ms: 100, end_ms: 400 }])
  }
}

describe('AudioSession finalization', () => {
  it('closes the provider before finalizing its trailing turn', async () => {
    const bus = new AmeliaBus()
    const emit = vi.spyOn(bus, 'emit')
    const session = new AudioSession({
      conversationId: 'conversation-flush',
      bus,
      provider: new FlushProvider(),
      identity: null,
      utterances: null,
    })

    await session.end()

    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'utterance',
      conversation_id: 'conversation-flush',
      text: 'flushed',
    }))
  })
})
