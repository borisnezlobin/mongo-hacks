import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

type AttributionResult = Awaited<ReturnType<AttributionService['attributeSpeaker']>>

/** Records every attribution call and replays a scripted verdict for each. */
function scriptedIdentity(
  script: (call: number) => AttributionResult,
): AttributionService & { inputs: { duration_ms: number; final?: boolean }[] } {
  const inputs: { duration_ms: number; final?: boolean }[] = []
  return {
    inputs,
    async attributeSpeaker(input) {
      inputs.push({ duration_ms: input.duration_ms, final: input.final })
      return script(inputs.length)
    },
  }
}

const ambiguous: AttributionResult = { status: 'pending', reason: 'ambiguous' }

/** Feed `turns` one-second turns of a single voice, one per audio chunk. */
async function speak(session: AudioSession, provider: ScriptedProvider, turns: number): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    const start = i * 1000
    provider.segments([{ speaker: `turn-${i}`, start_ms: start, end_ms: start + 1000 }])
    provider.words([{ text: `word${i}`, start_ms: start + 100, end_ms: start + 900 }])
    await session.pushAudio(speech(0.5, 1))
  }
}

function personIdsSeen(emit: ReturnType<typeof vi.spyOn>): (string | undefined)[] {
  return emit.mock.calls
    .map(([event]) => event as { type: string; person_id?: string })
    .filter((event) => event.type === 'utterance')
    .map((event) => event.person_id)
}

describe('AudioSession ambiguous attribution', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  /**
   * An ambiguous verdict is a request for more audio, not an answer. If it were
   * treated like a match the speaker would be locked to whichever of two
   * near-identical people happened to score higher, and never revisited — the
   * exact silent history-merge the margin exists to prevent.
   */
  it('never resolves a speaker that identity keeps calling ambiguous', async () => {
    const bus = new AmeliaBus()
    const emit = vi.spyOn(bus, 'emit')
    const provider = new ScriptedProvider()
    const identity = scriptedIdentity(() => ambiguous)
    const session = new AudioSession({
      conversationId: 'c-ambiguous',
      bus,
      provider,
      identity,
      utterances: null,
    })

    await speak(session, provider, 6)
    await session.end()

    expect(personIdsSeen(emit).every((personId) => personId === undefined)).toBe(true)
    expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'identity' }))
    expect(identity.inputs.length).toBeGreaterThan(1)
  })

  it('retries an ambiguous speaker on a later chunk and attaches the person it finds', async () => {
    const bus = new AmeliaBus()
    const emit = vi.spyOn(bus, 'emit')
    const provider = new ScriptedProvider()
    const identity = scriptedIdentity((call) => (
      call === 1
        ? ambiguous
        : { status: 'matched', person_id: 'person-1', voiceprint_id: 'voiceprint-1', confidence: 0.9 }
    ))
    const session = new AudioSession({
      conversationId: 'c-retry',
      bus,
      provider,
      identity,
      utterances: null,
    })

    await speak(session, provider, 6)

    expect(identity.inputs).toHaveLength(2)
    // The retry is worth making only because it sees more speech than the
    // verdict it is re-litigating.
    expect(identity.inputs[1].duration_ms).toBeGreaterThan(identity.inputs[0].duration_ms)
    expect(personIdsSeen(emit)).toContain('person-1')

    // Resolved speakers are never re-attributed, ambiguous history or not.
    await session.end()
    expect(identity.inputs).toHaveLength(2)
  })

  /**
   * maybeAttribute runs on every 100 ms frame and the embed call sits on the
   * same promise chain as audio ingest, so an ambiguous speaker that retried
   * unconditionally would embed the same clip dozens of times per second and
   * stall the transcript behind it.
   */
  it('waits for new speech before retrying rather than retrying every chunk', async () => {
    const bus = new AmeliaBus()
    const provider = new ScriptedProvider()
    const identity = scriptedIdentity(() => ambiguous)
    const session = new AudioSession({
      conversationId: 'c-throttle',
      bus,
      provider,
      identity,
      utterances: null,
    })

    // Six chunks past the floor, and the default retry gate is one floor of
    // fresh speech: two attempts, not one per chunk.
    await speak(session, provider, 6)

    expect(identity.inputs).toHaveLength(2)
  })

  it('honours ATTRIBUTION_RETRY_SPEECH_MS when deciding a retry has earned itself', async () => {
    vi.stubEnv('ATTRIBUTION_RETRY_SPEECH_MS', '1000')
    const bus = new AmeliaBus()
    const provider = new ScriptedProvider()
    const identity = scriptedIdentity(() => ambiguous)
    const session = new AudioSession({
      conversationId: 'c-eager',
      bus,
      provider,
      identity,
      utterances: null,
    })

    await speak(session, provider, 6)

    // One attempt at the floor, then one per additional second of speech.
    expect(identity.inputs).toHaveLength(4)
  })

  /**
   * A speaker cannot stay "Attributing…" forever. Once the attempts run out the
   * next call is marked final, which is identity's cue to fall through to its
   * best candidate instead of asking to wait again.
   */
  it('marks the call final once the attempt budget is spent', async () => {
    vi.stubEnv('ATTRIBUTION_MAX_ATTEMPTS', '1')
    const bus = new AmeliaBus()
    const provider = new ScriptedProvider()
    const identity = scriptedIdentity((call) => (
      call === 1
        ? ambiguous
        : { status: 'matched', person_id: 'person-1', voiceprint_id: 'voiceprint-1', confidence: 0.7 }
    ))
    const session = new AudioSession({
      conversationId: 'c-budget',
      bus,
      provider,
      identity,
      utterances: null,
    })

    await speak(session, provider, 4)

    expect(identity.inputs).toHaveLength(2)
    expect(identity.inputs[0].final).toBeUndefined()
    expect(identity.inputs[1].final).toBe(true)
  })

  it('marks the closing attempt final so the session does not end nameless', async () => {
    const bus = new AmeliaBus()
    const provider = new ScriptedProvider()
    const identity = scriptedIdentity(() => ambiguous)
    const session = new AudioSession({
      conversationId: 'c-final',
      bus,
      provider,
      identity,
      utterances: null,
    })

    await speak(session, provider, 3)
    expect(identity.inputs).toEqual([{ duration_ms: 3000, final: undefined }])

    await session.end()

    expect(identity.inputs[identity.inputs.length - 1].final).toBe(true)
  })

  /**
   * below_floor is the pre-existing pending reason and must not be swept into
   * the ambiguous throttle: those speakers have to be retried on every chunk,
   * because that is how they eventually cross the floor.
   */
  /**
   * .env.example ships this one blank, documenting the floor as its default.
   * Number('') is 0, which would turn the throttle off in exactly the setup a
   * teammate reaches by copying the example file — re-embedding the same clip
   * on every 100 ms frame, on the ingest chain.
   */
  it('reads a blank retry gate as the documented default, not as zero', async () => {
    vi.stubEnv('ATTRIBUTION_RETRY_SPEECH_MS', '')
    const bus = new AmeliaBus()
    const provider = new ScriptedProvider()
    const identity = scriptedIdentity(() => ambiguous)
    const session = new AudioSession({
      conversationId: 'c-blank-gate',
      bus,
      provider,
      identity,
      utterances: null,
    })

    await speak(session, provider, 6)

    expect(identity.inputs).toHaveLength(2)
  })

  /**
   * Blank or misspelt, the attempt budget must not silently become zero: that
   * would mark the very first call final, which is identity's licence to
   * coin-flip between two people the margin was holding apart.
   */
  it.each([['blank', ''], ['unparseable', 'three']])(
    'reads a %s attempt budget as the default rather than spending it up front',
    async (_label, value) => {
      vi.stubEnv('ATTRIBUTION_MAX_ATTEMPTS', value)
      vi.stubEnv('ATTRIBUTION_RETRY_SPEECH_MS', '1000')
      const bus = new AmeliaBus()
      const provider = new ScriptedProvider()
      const identity = scriptedIdentity(() => ambiguous)
      const session = new AudioSession({
        conversationId: 'c-blank-budget',
        bus,
        provider,
        identity,
        utterances: null,
      })

      await speak(session, provider, 6)

      expect(identity.inputs.map((input) => input.final)).toEqual([
        undefined,
        undefined,
        undefined,
        true,
      ])
    },
  )

  it('does not throttle the below-floor pending reason', async () => {
    const bus = new AmeliaBus()
    const provider = new ScriptedProvider()
    const identity = scriptedIdentity(() => ({ status: 'pending', reason: 'below_floor' }))
    const session = new AudioSession({
      conversationId: 'c-below',
      bus,
      provider,
      identity,
      utterances: null,
    })

    await speak(session, provider, 6)

    // Once per chunk from the floor onwards, exactly as before this change.
    expect(identity.inputs).toHaveLength(4)
  })
})
