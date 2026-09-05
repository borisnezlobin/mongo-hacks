import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OwnerCheckResponse } from '../../shared/contracts'
import { AUDIO_FRAME_SAMPLES, OWNER_CHECK_MIN_MS } from '../../shared/contracts'
import { AmeliaBus } from '../lib/bus'

const sidecar = vi.hoisted(() => ({
  embedPcm: vi.fn(),
  embedPcmForClustering: vi.fn(),
}))
vi.mock('./embed-client', () => sidecar)

const identity = vi.hoisted(() => ({ isOwnerVoice: vi.fn() }))
vi.mock('../identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../identity')>()),
  createIdentityService: () => identity,
}))

/** One-shot storage failure, so the lane's "nothing is saved" path is reachable. */
const storage = vi.hoisted(() => ({ failNext: false }))
vi.mock('../storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../storage')>()
  return {
    ...actual,
    getStorage: async () => {
      if (!storage.failNext) return actual.getStorage()
      storage.failNext = false
      throw new Error('storage is unreachable')
    },
  }
})

import { registerAudioRoutes } from './index'

const SAMPLE_RATE_HZ = AUDIO_FRAME_SAMPLES * 10

function pcmOfMs(durationMs: number): ArrayBuffer {
  return new Float32Array(Math.round((durationMs / 1000) * SAMPLE_RATE_HZ)).buffer
}

function ownerCheck(body: ArrayBuffer) {
  const app = new Hono()
  registerAudioRoutes(app, { bus: new AmeliaBus() } as never)
  return app.request('/audio/owner-check', { method: 'POST', body })
}

beforeEach(() => {
  sidecar.embedPcm.mockReset()
  identity.isOwnerVoice.mockReset()
  sidecar.embedPcm.mockResolvedValue({ vector: new Array(192).fill(0.1), duration_ms: OWNER_CHECK_MIN_MS })
  identity.isOwnerVoice.mockResolvedValue({ authorized: true, confidence: 0.82 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('asking whether a clip is the owner talking', () => {
  // Declared first on purpose: it is the only test that must reach audioDeps
  // before the lane has cached a working store.
  it('answers 503 when there is no store to score against', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    storage.failNext = true

    const response = await ownerCheck(pcmOfMs(OWNER_CHECK_MIN_MS + 1_000))

    expect(response.status).toBe(503)
  })

  it('refuses a body that is not whole float32 samples', async () => {
    const response = await ownerCheck(new Uint8Array([1, 2, 3]).buffer)

    expect(response.status).toBe(400)
    expect(sidecar.embedPcm).not.toHaveBeenCalled()
  })

  it('refuses a clip shorter than the embedding floor rather than guessing from it', async () => {
    const response = await ownerCheck(pcmOfMs(OWNER_CHECK_MIN_MS - 500))

    expect(response.status).toBe(422)
    expect(sidecar.embedPcm).not.toHaveBeenCalled()
  })

  it('says yes with the score behind it', async () => {
    const response = await ownerCheck(pcmOfMs(OWNER_CHECK_MIN_MS + 1_000))

    expect(response.status).toBe(200)
    expect((await response.json()) as OwnerCheckResponse).toEqual({
      owner: true,
      score: 0.82,
      duration_ms: OWNER_CHECK_MIN_MS,
    })
  })

  it('says no for a voice that is not the owner, without failing the request', async () => {
    identity.isOwnerVoice.mockResolvedValue({ authorized: false, confidence: 0.31 })

    const response = await ownerCheck(pcmOfMs(OWNER_CHECK_MIN_MS + 1_000))

    expect(response.status).toBe(200)
    expect(((await response.json()) as OwnerCheckResponse).owner).toBe(false)
  })
})
