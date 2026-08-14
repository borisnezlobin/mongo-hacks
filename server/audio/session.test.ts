import { beforeEach, describe, expect, it, vi } from 'vitest'
import { VOICEPRINT_DIMS } from '../../shared/contracts'
import { AmeliaBus } from '../lib/bus'
import { AudioSession, type AttributionService } from './session'
import type { Segment, StreamProvider, Word } from './types'

/**
 * The clustering path calls the sidecar. These tests are about the join logic,
 * so the sidecar is replaced by two deterministic, well-separated voices.
 */
const embedded: Float32Array[] = []
vi.mock('./embed-client', () => ({
  embedPcm: async (pcm: Float32Array) => {
    embedded.push(pcm)
    return { vector: voiceOf(pcm), duration_ms: (pcm.length / 16_000) * 1000 }
  },
  embedPcmForClustering: async (pcm: Float32Array) => ({
    vector: voiceOf(pcm),
    duration_ms: (pcm.length / 16_000) * 1000,
  }),
}))

/** Sample value doubles as speaker identity: every frame we push is a constant. */
function voiceOf(pcm: Float32Array): number[] {
  const seed = pcm.length > 0 ? Math.round(pcm[0] * 10) : 0
  const raw = Array.from({ length: VOICEPRINT_DIMS }, (_, i) => Math.sin((i + 1) * (seed + 1) * 0.37))
  const norm = Math.sqrt(raw.reduce((sum, v) => sum + v * v, 0))
  return raw.map((v) => v / norm)
}

class ScriptedProvider implements StreamProvider {
  segments: (segments: Segment[]) => void = () => {}
  words: (words: Word[]) => void = () => {}
  pushAudio(): void {}
  onSegments(handler: (segments: Segment[]) => void): void { this.segments = handler }
  onWords(handler: (words: Word[]) => void): void { this.words = handler }
  async close(): Promise<void> {}
}

class FlushProvider extends ScriptedProvider {
  async close(): Promise<void> {
    this.segments([{ speaker: 'S0', start_ms: 0, end_ms: 500 }])
    this.words([{ text: 'flushed', start_ms: 100, end_ms: 400 }])
  }
}

/** One second of PCM whose sample value identifies the speaker. */
function speech(level: number, seconds: number): Float32Array {
  return new Float32Array(Math.round(16_000 * seconds)).fill(level)
}

function collectingIdentity(): AttributionService & { calls: number[] } {
  const calls: number[] = []
  return {
    calls,
    async attributeSpeaker(input) {
      calls.push(input.duration_ms)
      return { status: 'created', person_id: `p-${calls.length}`, voiceprint_id: `v-${calls.length}` }
    },
  }
}

beforeEach(() => {
  embedded.length = 0
})

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

describe('AudioSession speaker clustering', () => {
  /**
   * The regression this whole change exists for. Without a diarising model the
   * provider labels every VAD turn separately, so a speaker's turns used to be
   * measured one at a time against the 3000 ms embedding floor and none of them
   * ever cleared it. Pooled into a cluster, the same turns clear it together.
   */
  it('attributes a speaker whose turns are individually under the floor', async () => {
    const bus = new AmeliaBus()
    const provider = new ScriptedProvider()
    const identity = collectingIdentity()
    const session = new AudioSession({
      conversationId: 'c-short',
      bus,
      provider,
      identity,
      utterances: null,
    })

    // Four separate 1s turns from one voice: never 3s at once, 4s in total.
    for (let i = 0; i < 4; i += 1) {
      const start = i * 1000
      provider.segments([{ speaker: `turn-${i}`, start_ms: start, end_ms: start + 1000 }])
      provider.words([{ text: `word${i}`, start_ms: start + 100, end_ms: start + 900 }])
      await session.pushAudio(speech(0.5, 1))
    }
    await session.end()

    expect(identity.calls).toHaveLength(1)
    expect(identity.calls[0]).toBeGreaterThanOrEqual(3000)
  })

  it('keeps two voices apart instead of pooling them into one person', async () => {
    const bus = new AmeliaBus()
    const provider = new ScriptedProvider()
    const identity = collectingIdentity()
    const session = new AudioSession({ conversationId: 'c-two', bus, provider, identity, utterances: null })

    for (let i = 0; i < 4; i += 1) {
      const start = i * 2000
      provider.segments([{ speaker: `turn-${i}`, start_ms: start, end_ms: start + 2000 }])
      provider.words([{ text: `word${i}`, start_ms: start + 100, end_ms: start + 1900 }])
      // Alternating speakers, 2s each: both clear the floor independently.
      await session.pushAudio(speech(i % 2 === 0 ? 0.5 : -0.5, 2))
    }
    await session.end()

    expect(identity.calls).toHaveLength(2)
  })

  it('tells the client a speaker is being attributed before it knows who', async () => {
    const bus = new AmeliaBus()
    const emit = vi.spyOn(bus, 'emit')
    const provider = new ScriptedProvider()
    const session = new AudioSession({
      conversationId: 'c-pending',
      bus,
      provider,
      // Never resolves, so the pending state is all the client ever sees.
      identity: { async attributeSpeaker() { return { status: 'pending', reason: 'below_floor' } } },
      utterances: null,
    })

    provider.segments([{ speaker: 'turn-0', start_ms: 0, end_ms: 800 }])
    provider.words([{ text: 'yeah', start_ms: 100, end_ms: 700 }])
    await session.pushAudio(speech(0.5, 1))
    await session.end()

    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'speaker_pending',
      conversation_id: 'c-pending',
    }))
  })

  it('embeds the cluster once, not once per turn', async () => {
    const bus = new AmeliaBus()
    const provider = new ScriptedProvider()
    const session = new AudioSession({
      conversationId: 'c-once',
      bus,
      provider,
      identity: collectingIdentity(),
      utterances: null,
    })

    for (let i = 0; i < 5; i += 1) {
      const start = i * 1000
      provider.segments([{ speaker: `turn-${i}`, start_ms: start, end_ms: start + 1000 }])
      provider.words([{ text: `word${i}`, start_ms: start + 100, end_ms: start + 900 }])
      await session.pushAudio(speech(0.5, 1))
    }
    await session.end()

    // embedPcm is the attribution embedding; clustering uses the other export.
    expect(embedded).toHaveLength(1)
  })
})
