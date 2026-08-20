import { beforeEach, describe, expect, it, vi } from 'vitest'
import { VOICEPRINT_DIMS, type AmeliaEvent, type UtteranceEvent } from '../../shared/contracts'
import { AmeliaBus } from '../lib/bus'
import { tmpdir } from 'node:os'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readAudioConfig } from './config'
import { encodeWavBytes } from './wav-util'
import { AudioSession } from './session'
import type { Segment, StreamProvider, Word } from './types'

vi.mock('./embed-client', () => ({
  embedPcm: async (pcm: Float32Array) => ({ vector: voiceOf(pcm), duration_ms: (pcm.length / 16_000) * 1000 }),
  embedPcmForClustering: async (pcm: Float32Array) => ({
    vector: voiceOf(pcm),
    duration_ms: (pcm.length / 16_000) * 1000,
  }),
}))

/**
 * whisper and pyannote are both driven from here rather than over the network:
 * what is under test is the join and the rewrite, not the models. The scripted
 * pair is the case the whole pass exists for — one live line, two voices.
 */
const WHISPER_WORDS = [
  { text: 'mine', start_ms: 500, end_ms: 2_000 },
  { text: 'still-mine', start_ms: 2_500, end_ms: 4_500 },
  { text: 'yours', start_ms: 5_500, end_ms: 7_000 },
  { text: 'also-yours', start_ms: 7_500, end_ms: 9_500 },
]
const PYANNOTE_TURNS = [
  { speaker: 'SPEAKER_00', start_ms: 0, end_ms: 5_000 },
  { speaker: 'SPEAKER_01', start_ms: 5_000, end_ms: 10_000 },
]

const transcript = vi.hoisted(() => ({
  words: [] as { text: string; start_ms: number; end_ms: number }[],
}))
const diarization = vi.hoisted(() => ({
  turns: [] as { speaker: string; start_ms: number; end_ms: number }[],
  overlapMs: 0,
}))

vi.mock('./whisper-client', () => ({
  transcribeWithTimings: async () => ({ text: '', words: transcript.words, segments: [] }),
}))
vi.mock('./diarize-sidecar', () => ({
  diarizeAudio: async () => ({
    turns: diarization.turns,
    speakers: [...new Set(diarization.turns.map((turn) => turn.speaker))],
    overlapMs: diarization.overlapMs,
    durationMs: 10_000,
    elapsedMs: 8_000,
  }),
}))

function voiceOf(pcm: Float32Array): number[] {
  const seed = pcm.length > 0 ? Math.round(pcm[0] * 10) : 0
  const raw = Array.from({ length: VOICEPRINT_DIMS }, (_, i) => Math.sin((i + 1) * (seed + 1) * 0.37))
  const norm = Math.sqrt(raw.reduce((sum, value) => sum + value * value, 0))
  return raw.map((value) => value / norm)
}

class ScriptedProvider implements StreamProvider {
  segments: (segments: Segment[]) => void = () => {}
  words: (words: Word[]) => void = () => {}
  pushAudio(): void {}
  onSegments(handler: (segments: Segment[]) => void): void { this.segments = handler }
  onWords(handler: (words: Word[]) => void): void { this.words = handler }
  async close(): Promise<void> {}
}

/** A real (silent) file, so the pass reaches the join rather than failing at I/O. */
const wavPath = join(tmpdir(), 'amelia-final-pass-test.wav')
writeFileSync(wavPath, encodeWavBytes(new Float32Array(16_000 * 10)))

function recorderFor(durationMs: number, isTruncated = false) {
  return {
    path: wavPath,
    durationMs,
    isTruncated,
    write: () => {},
    close: async () => wavPath,
  } as unknown as ConstructorParameters<typeof AudioSession>[0]['recorder']
}

async function sessionWithOneRunOnLine(): Promise<{
  session: AudioSession
  emitted: UtteranceEvent[]
}> {
  const bus = new AmeliaBus()
  const emitted: UtteranceEvent[] = []
  vi.spyOn(bus, 'emit').mockImplementation(((event: AmeliaEvent) => {
    if (event.type === 'utterance') emitted.push(event)
  }) as typeof bus.emit)
  const provider = new ScriptedProvider()
  const session = new AudioSession({
    conversationId: 'c-recut',
    bus,
    provider,
    identity: null,
    utterances: null,
    recorder: recorderFor(10_000),
    config: { ...readAudioConfig({}), finalPassEnabled: true },
  })
  // One VAD turn, one line, two voices — the case the whole pass exists for.
  provider.segments([{ speaker: 'vad-0', start_ms: 0, end_ms: 10_000 }])
  provider.words(WHISPER_WORDS.map((word) => ({ ...word })))
  await session.pushAudio(new Float32Array(16_000 * 10).fill(0.5))
  await session.end()
  return { session, emitted }
}

beforeEach(() => {
  transcript.words = WHISPER_WORDS.map((word) => ({ ...word }))
  diarization.turns = PYANNOTE_TURNS.map((turn) => ({ ...turn }))
  diarization.overlapMs = 0
})

describe('rebuilding the transcript from whisper and pyannote', () => {
  it('divides a line at the speaker boundary, keeping the original id on the first piece', async () => {
    const { session } = await sessionWithOneRunOnLine()
    const before = session.transcript.map((record) => record.utterance_id)
    expect(before).toHaveLength(1)

    const report = await session.runFinalPass()

    expect(report.ran).toBe(true)
    expect(report.split).toBe(1)
    const after = session.transcript
    expect(after).toHaveLength(2)
    // The row the user is already looking at revises rather than vanishing.
    expect(after[0].utterance_id).toBe(before[0])
    expect(after[1].utterance_id).not.toBe(before[0])
    expect(after[0].session_speaker).not.toBe(after[1].session_speaker)
  })

  it('puts each word on the side of the boundary it was spoken', async () => {
    const { session } = await sessionWithOneRunOnLine()
    await session.runFinalPass()
    const [first, second] = session.transcript
    expect(first.text).toBe('mine still-mine')
    expect(second.text).toBe('yours also-yours')
  })

  it('reports how much of the transcript it could put on a speaker', async () => {
    const { session } = await sessionWithOneRunOnLine()
    const report = await session.runFinalPass()
    expect(report.totalWords).toBe(4)
    expect(report.attributedWords).toBe(4)
    expect(report.labels).toEqual(['SPEAKER_00', 'SPEAKER_01'])
  })

  it('leaves a single-speaker line as one line', async () => {
    diarization.turns = [{ speaker: 'SPEAKER_00', start_ms: 0, end_ms: 10_000 }]
    const { session } = await sessionWithOneRunOnLine()
    await session.runFinalPass()
    expect(session.transcript).toHaveLength(1)
  })

  /**
   * The live pass produces fragments the coherent transcript does not contain.
   * Without a way to say a line is gone, it sits under the corrected transcript
   * holding text nobody said and a name nobody agreed to.
   */
  it('supersedes a live line the rebuilt transcript has no counterpart for', async () => {
    const { session, emitted } = await sessionWithOneRunOnLine()
    // Whisper heard only the first half of the recording this time.
    transcript.words = WHISPER_WORDS.slice(0, 2).map((word) => ({ ...word }))
    // A second live line nothing in the rebuilt transcript overlaps.
    const extra = {
      utterance_id: 'stale',
      session_speaker: 'vad-1',
      text: 'but like',
      start_ms: 6_000,
      end_ms: 9_000,
      is_final: true,
    }
    ;(session as unknown as { emitted: Map<number, typeof extra> }).emitted.set(6_000, extra)

    const report = await session.runFinalPass()

    expect(report.superseded).toBe(1)
    expect(session.transcript.map((record) => record.utterance_id)).not.toContain('stale')
    expect(emitted).toContainEqual(expect.objectContaining({ utterance_id: 'stale', superseded: true, text: '' }))
  })

  it('hedges a line somebody else spoke across, so extraction cannot file it', async () => {
    diarization.turns = [
      { speaker: 'SPEAKER_00', start_ms: 0, end_ms: 10_000 },
      { speaker: 'SPEAKER_01', start_ms: 400, end_ms: 3_000 },
    ]
    diarization.overlapMs = 2_600
    const { session } = await sessionWithOneRunOnLine()
    const report = await session.runFinalPass()
    expect(report.overlapMs).toBe(2_600)
    expect(session.transcript.some((record) => record.identity_confidence === 'confirmed')).toBe(false)
  })

  it('says so rather than guessing when the diarizer heard nobody', async () => {
    diarization.turns = []
    const { session } = await sessionWithOneRunOnLine()
    const report = await session.runFinalPass()
    expect(report.ran).toBe(true)
    expect(report.reason).toContain('heard nobody')
    expect(session.transcript).toHaveLength(1)
  })
})

/**
 * A recording that outran the retention cap must say so, and must not quietly
 * re-label the part the correction pass never heard.
 */
describe('a truncated recording', () => {
  function truncatedSession(retainedMs: number) {
    const bus = new AmeliaBus()
    const events: AmeliaEvent[] = []
    vi.spyOn(bus, 'emit').mockImplementation(((event: AmeliaEvent) => {
      events.push(event)
    }) as typeof bus.emit)
    const session = new AudioSession({
      conversationId: 'c-truncated',
      bus,
      provider: new ScriptedProvider(),
      identity: null,
      utterances: null,
      recorder: recorderFor(retainedMs, true),
      config: { ...readAudioConfig({}), finalPassEnabled: true },
    })
    return { session, events }
  }

  it('tells the client how far the correction could actually see', async () => {
    const { session, events } = truncatedSession(2_700_000)
    await session.runFinalPass()
    expect(events).toContainEqual({
      type: 'conversation',
      conversation_id: 'c-truncated',
      audio_truncated: true,
      covered_to_ms: 2_700_000,
    })
  })

  it('reports the speech the correction could not cover', async () => {
    const { session } = truncatedSession(2_700_000)
    const report = await session.runFinalPass()
    expect(report.truncated).toBe(true)
    expect(report.retainedMs).toBe(2_700_000)
    expect(report.uncoveredMs).toBe(0)
  })
})
