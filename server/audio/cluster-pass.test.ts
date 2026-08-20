import { describe, expect, it, vi } from 'vitest'
import { VOICEPRINT_DIMS } from '../../shared/contracts'
import { groupRuns, smooth } from './cluster-pass'
import { readAudioConfig } from './config'

vi.mock('./embed-client', () => ({
  embedPcm: async (pcm: Float32Array) => ({ vector: voiceOf(pcm), duration_ms: (pcm.length / 16_000) * 1000 }),
  embedPcmForClustering: async (pcm: Float32Array) => ({
    vector: voiceOf(pcm),
    duration_ms: (pcm.length / 16_000) * 1000,
  }),
}))

/** Sample value doubles as speaker identity, as in session.test.ts. */
function voiceOf(pcm: Float32Array): number[] {
  const seed = pcm.length > 0 ? Math.round(pcm[0] * 10) : 0
  const raw = Array.from({ length: VOICEPRINT_DIMS }, (_, i) => Math.sin((i + 1) * (seed + 1) * 0.37))
  const norm = Math.sqrt(raw.reduce((sum, value) => sum + value * value, 0))
  return raw.map((value) => value / norm)
}

function audioOf(plan: { level: number; seconds: number }[]): Float32Array {
  const total = plan.reduce((n, part) => n + part.seconds * 16_000, 0)
  const out = new Float32Array(total)
  let offset = 0
  for (const part of plan) {
    out.fill(part.level, offset, offset + part.seconds * 16_000)
    offset += part.seconds * 16_000
  }
  return out
}

describe('smooth', () => {
  it('flips a lone dissenting window and leaves a real two-window turn alone', () => {
    expect(smooth(['a', 'a', 'b', 'a', 'a'])).toEqual(['a', 'a', 'a', 'a', 'a'])
    expect(smooth(['a', 'a', 'b', 'b', 'a'])).toEqual(['a', 'a', 'b', 'b', 'a'])
  })

  it('does not invent a label where both neighbours abstained', () => {
    expect(smooth([null, 'b', null])).toEqual([null, 'b', null])
  })
})

describe('groupRuns', () => {
  const windows = [
    { start_ms: 0, end_ms: 1_500 },
    { start_ms: 750, end_ms: 2_250 },
    { start_ms: 1_500, end_ms: 3_000 },
    { start_ms: 2_250, end_ms: 3_750 },
    { start_ms: 3_000, end_ms: 4_500 },
    { start_ms: 3_750, end_ms: 5_250 },
  ]
  const turn = { start_ms: 0, end_ms: 6_000 }

  it('tiles the turn exactly, with no gap and no overlap', () => {
    const runs = groupRuns(['a', 'a', 'a', 'b', 'b', 'b'], windows, turn)

    expect(runs[0].start_ms).toBe(turn.start_ms)
    expect(runs[runs.length - 1].end_ms).toBe(turn.end_ms)
    for (let i = 1; i < runs.length; i += 1) expect(runs[i].start_ms).toBe(runs[i - 1].end_ms)
  })

  it('absorbs an undecided window into the run beside it', () => {
    expect(groupRuns(['a', null, 'a', 'a', 'a', 'a'], windows, turn)).toHaveLength(1)
  })
})
