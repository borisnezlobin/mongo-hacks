import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  VOICEPRINT_DIMS,
  type AmeliaEvent,
  type IdentityConfidence,
  type UtteranceEvent,
} from '../../shared/contracts'
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
      return {
        status: 'created',
        person_id: `p-${calls.length}`,
        voiceprint_id: `v-${calls.length}`,
        identity_confidence: 'confirmed',
      }
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
      recorder: null,
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
      recorder: null,
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
    const session = new AudioSession({ conversationId: 'c-two', bus, provider, identity, utterances: null, recorder: null })

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
      identity: { async attributeSpeaker() { return { status: 'pending' as const, reason: 'below_floor' as const } } },
      utterances: null,
      recorder: null,
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
      recorder: null,
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

describe('AudioSession identification inputs', () => {
  it('hands identity the session mean, without which cross-session matching is raw cosine', async () => {
    const bus = new AmeliaBus()
    const provider = new ScriptedProvider()
    const seen: (number[] | null | undefined)[] = []
    const session = new AudioSession({
      conversationId: 'c-mean',
      bus,
      provider,
      identity: {
        async attributeSpeaker(input) {
          seen.push(input.session_mean)
          return { status: 'pending' as const, reason: 'no_match' as const }
        },
      },
      utterances: null,
      recorder: null,
    })

    for (let i = 0; i < 4; i += 1) {
      const start = i * 1000
      provider.segments([{ speaker: `turn-${i}`, start_ms: start, end_ms: start + 1000 }])
      provider.words([{ text: `word${i}`, start_ms: start + 100, end_ms: start + 900 }])
      await session.pushAudio(speech(0.5, 1))
    }
    await session.end()

    expect(seen.length).toBeGreaterThan(0)
    expect(seen[0]).toHaveLength(VOICEPRINT_DIMS)
    expect(session.sessionMean).toHaveLength(VOICEPRINT_DIMS)
  })

  /**
   * The whole cluster's pooled audio used to be re-embedded on every 100 ms
   * frame once it was over the floor and still unnamed — quadratic in session
   * length against a single-threaded CPU sidecar.
   */
  it('does not re-embed an unresolved cluster on every audio frame', async () => {
    const bus = new AmeliaBus()
    const provider = new ScriptedProvider()
    const session = new AudioSession({
      conversationId: 'c-ladder',
      bus,
      provider,
      identity: { async attributeSpeaker() { return { status: 'pending' as const, reason: 'no_match' as const } } },
      utterances: null,
      recorder: null,
    })

    for (let i = 0; i < 12; i += 1) {
      const start = i * 1000
      provider.segments([{ speaker: `turn-${i}`, start_ms: start, end_ms: start + 1000 }])
      provider.words([{ text: `word${i}`, start_ms: start + 100, end_ms: start + 900 }])
      await session.pushAudio(speech(0.5, 1))
    }
    await session.end()

    // Twelve seconds of speech crosses the 3 s floor and the 8 s provisional
    // rung, and nothing else. Four attempts would already be a regression.
    expect(embedded.length).toBeLessThanOrEqual(3)
  })

  it('keeps re-attributing a provisional identity so it can become confirmed', async () => {
    const bus = new AmeliaBus()
    const provider = new ScriptedProvider()
    const tiers: string[] = []
    const session = new AudioSession({
      conversationId: 'c-provisional',
      bus,
      provider,
      identity: {
        async attributeSpeaker() {
          const tier = tiers.length === 0 ? 'provisional' : 'confirmed'
          tiers.push(tier)
          return {
            status: 'matched' as const,
            person_id: 'p-1',
            voiceprint_id: 'v-1',
            confidence: 0.4,
            identity_confidence: tier as 'provisional' | 'confirmed',
          }
        },
      },
      utterances: null,
      recorder: null,
    })

    // Past the confirmed rung at 20 s, so the ladder has somewhere to escalate to.
    for (let i = 0; i < 26; i += 1) {
      const start = i * 1000
      provider.segments([{ speaker: `turn-${i}`, start_ms: start, end_ms: start + 1000 }])
      provider.words([{ text: `word${i}`, start_ms: start + 100, end_ms: start + 900 }])
      await session.pushAudio(speech(0.5, 1))
    }
    await session.end()

    expect(tiers).toContain('confirmed')
  })

  /**
   * Extraction refuses to file a fact against a speaker below 'confirmed' and
   * treats an absent confidence as not-confirmed. So an utterance that never
   * carries the field, or that keeps a stale 'provisional' after the identity
   * settled, is a speaker nothing is ever recorded about — and nothing in the
   * transcript looks wrong.
   */
  it('emits the identity tier, and re-emits when a provisional identity is confirmed', async () => {
    const bus = new AmeliaBus()
    const events: UtteranceEvent[] = []
    vi.spyOn(bus, 'emit').mockImplementation(((event: AmeliaEvent) => {
      if (event.type === 'utterance') events.push(event)
    }) as typeof bus.emit)
    const provider = new ScriptedProvider()
    let calls = 0
    const session = new AudioSession({
      conversationId: 'c-tier',
      bus,
      provider,
      identity: {
        async attributeSpeaker() {
          calls += 1
          return {
            status: 'matched' as const,
            person_id: 'p-1',
            voiceprint_id: 'v-1',
            confidence: 0.9,
            identity_confidence: (calls === 1 ? 'provisional' : 'confirmed') as IdentityConfidence,
          }
        },
      },
      utterances: null,
      recorder: null,
    })

    for (let i = 0; i < 26; i += 1) {
      const start = i * 1000
      provider.segments([{ speaker: `turn-${i}`, start_ms: start, end_ms: start + 1000 }])
      provider.words([{ text: `word${i}`, start_ms: start + 100, end_ms: start + 900 }])
      await session.pushAudio(speech(0.5, 1))
    }
    await session.end()

    const named = events.filter((event) => event.person_id === 'p-1')
    expect(named.length).toBeGreaterThan(0)
    // Never a named speaker with no tier: that reads as not-confirmed downstream
    // and would be indistinguishable from a guess.
    expect(named.every((event) => event.identity_confidence !== undefined)).toBe(true)
    // The upgrade reached the client. The person_id never changed, so only the
    // tier distinguishes these two revisions.
    expect(named.some((event) => event.identity_confidence === 'confirmed')).toBe(true)
  })

  /**
   * A dead sidecar and a quiet room used to produce identical output: console
   * noise and no names.
   */
  it('tells the client when identification is failing rather than merely waiting', async () => {
    const bus = new AmeliaBus()
    const emit = vi.spyOn(bus, 'emit')
    const provider = new ScriptedProvider()
    const session = new AudioSession({
      conversationId: 'c-degraded',
      bus,
      provider,
      identity: { async attributeSpeaker() { throw new Error('connect ECONNREFUSED 127.0.0.1:8099') } },
      utterances: null,
      recorder: null,
    })

    for (let i = 0; i < 30; i += 1) {
      const start = i * 1000
      provider.segments([{ speaker: `turn-${i}`, start_ms: start, end_ms: start + 1000 }])
      provider.words([{ text: `word${i}`, start_ms: start + 100, end_ms: start + 900 }])
      await session.pushAudio(speech(0.5, 1))
    }
    await session.end()

    expect(session.degradedReason).toContain('ECONNREFUSED')
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'amelia_step', step: 'error' }),
    )
  })

  it('reports how much speech a pending speaker has and why they are still pending', async () => {
    const bus = new AmeliaBus()
    const events: { speech_ms?: number; provisional_speech_ms?: number; reason?: string }[] = []
    vi.spyOn(bus, 'emit').mockImplementation(((event: AmeliaEvent) => {
      if (event.type === 'speaker_pending') events.push(event)
    }) as typeof bus.emit)
    const provider = new ScriptedProvider()
    const session = new AudioSession({
      conversationId: 'c-reason',
      bus,
      provider,
      identity: { async attributeSpeaker() { return { status: 'pending' as const, reason: 'ambiguous' as const } } },
      utterances: null,
      recorder: null,
    })

    for (let i = 0; i < 5; i += 1) {
      const start = i * 1000
      provider.segments([{ speaker: `turn-${i}`, start_ms: start, end_ms: start + 1000 }])
      provider.words([{ text: `word${i}`, start_ms: start + 100, end_ms: start + 900 }])
      await session.pushAudio(speech(0.5, 1))
    }
    await session.end()

    expect(events[0].provisional_speech_ms).toBe(8_000)
    expect(events.map((event) => event.reason)).toContain('ambiguous')
  })
})

describe('AudioSession revision identity', () => {
  /**
   * The provider re-times a turn as it revises it, so the same sentence used to
   * land on a fresh start_ms, mint a fresh utterance_id, and appear twice.
   */
  it('revises a turn in place when the provider moves its start time', async () => {
    const bus = new AmeliaBus()
    const ids = new Set<string>()
    vi.spyOn(bus, 'emit').mockImplementation(((event: AmeliaEvent) => {
      if (event.type === 'utterance') ids.add(event.utterance_id)
    }) as typeof bus.emit)
    const provider = new ScriptedProvider()
    const session = new AudioSession({
      conversationId: 'c-revise',
      bus,
      provider,
      identity: null,
      utterances: null,
      recorder: null,
    })

    provider.segments([{ speaker: 'S0', start_ms: 0, end_ms: 4_000 }])
    provider.words([{ text: 'hello', start_ms: 500, end_ms: 1_400, turn: 'S0' }])
    await session.pushAudio(speech(0.5, 1))
    provider.words([{ text: 'hello', start_ms: 620, end_ms: 1_500, turn: 'S0' }])
    await session.pushAudio(speech(0.5, 1))
    await session.end()

    expect(ids.size).toBe(1)
  })

  /**
   * Clustering relabels a turn after its first words are already on screen, and
   * the pre-relabel record used to stay in the map forever under its raw
   * provider label. On the real dorm recording that alone manufactured
   * twenty-four phantom speakers out of three.
   */
  it('drops a record that a relabelling absorbed instead of keeping a phantom speaker', async () => {
    const bus = new AmeliaBus()
    const provider = new ScriptedProvider()
    const session = new AudioSession({
      conversationId: 'c-absorb',
      bus,
      provider,
      identity: null,
      utterances: null,
      recorder: null,
    })

    for (let i = 0; i < 3; i += 1) {
      const start = i * 2000
      provider.segments([{ speaker: `turn-${i}`, start_ms: start, end_ms: start + 2000 }])
      provider.words([{ text: `word${i}`, start_ms: start + 100, end_ms: start + 1900 }])
      await session.pushAudio(speech(0.5, 2))
    }
    await session.end()

    const speakers = new Set(session.transcript.map((record) => record.session_speaker))
    expect(speakers.size).toBe(1)
    expect([...speakers][0]).toMatch(/^cluster-/)
  })
})

describe('AudioSession run-on turns', () => {
  /**
   * The defect that made three people in a dorm room come out as one. Server
   * VAD hands back a single 12-second "turn" spanning three speakers; embedding
   * it whole yields a mixture, and every mixture resembles every other one.
   */
  it('splits a VAD turn that contains more than one voice', async () => {
    const bus = new AmeliaBus()
    const provider = new ScriptedProvider()
    const session = new AudioSession({
      conversationId: 'c-runon',
      bus,
      provider,
      identity: null,
      utterances: null,
      recorder: null,
    })

    // Two ordinary turns first, so both voices have a pooled centroid to be
    // recognised against — a run-on with nothing established stays whole.
    for (const [index, level] of [0.5, -0.5].entries()) {
      const start = index * 4000
      provider.segments([{ speaker: `intro-${index}`, start_ms: start, end_ms: start + 4000 }])
      provider.words([{ text: `intro${index}`, start_ms: start + 100, end_ms: start + 3900 }])
      await session.pushAudio(speech(level, 4))
    }
    // Now one VAD turn holding both voices, five seconds each.
    provider.segments([{ speaker: 'run-on', start_ms: 8_000, end_ms: 18_000 }])
    provider.words([
      { text: 'first', start_ms: 8_200, end_ms: 12_500 },
      { text: 'second', start_ms: 13_500, end_ms: 17_800 },
    ])
    await session.pushAudio(speech(0.5, 5))
    await session.pushAudio(speech(-0.5, 5))
    await session.end()

    const speakers = new Set(session.transcript.map((record) => record.session_speaker))
    expect(speakers.size).toBe(2)
  })

  it('leaves a long turn whole when it really is one voice', async () => {
    const bus = new AmeliaBus()
    const provider = new ScriptedProvider()
    const session = new AudioSession({
      conversationId: 'c-solo',
      bus,
      provider,
      identity: null,
      utterances: null,
      recorder: null,
    })

    provider.segments([{ speaker: 'intro', start_ms: 0, end_ms: 4_000 }])
    provider.words([{ text: 'intro', start_ms: 100, end_ms: 3_900 }])
    await session.pushAudio(speech(0.5, 4))
    provider.segments([{ speaker: 'long', start_ms: 4_000, end_ms: 14_000 }])
    provider.words([{ text: 'monologue', start_ms: 4_200, end_ms: 13_800 }])
    await session.pushAudio(speech(0.5, 10))
    await session.end()

    expect(new Set(session.transcript.map((record) => record.session_speaker)).size).toBe(1)
  })
})
