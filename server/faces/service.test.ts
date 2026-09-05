import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FaceObservationRequest, Faceprint, Person } from '../../shared/contracts'
import { FACE_CONFIRM_FRAMES, FACE_MIN_DET_SCORE, OWNER_ID } from '../../shared/contracts'
import { AmeliaBus } from '../lib/bus'
import { createLocalDriver, type LocalDriver } from '../storage'
import { FaceSidecarError, type FaceEmbedding } from './embed-client'
import { conversationForStorage, createFaceService, type FaceService } from './service'
import type { PresenceTracker } from './presence'

const MAYA_FACE = faceVector(0)
const STRANGER_FACE = faceVector(1.4)

function faceVector(angle: number): number[] {
  const embedding = new Array<number>(512).fill(0)
  embedding[0] = Math.cos(angle)
  embedding[1] = Math.sin(angle)
  return embedding
}

function embeddingOf(vector: number[], detScore = 0.95): FaceEmbedding {
  return { vector, det_score: detScore, bbox: { x: 0, y: 0, width: 10, height: 10 }, elapsed_ms: 5 }
}

function observation(overrides: Partial<FaceObservationRequest> = {}): FaceObservationRequest {
  return {
    frame_ts_ms: 0,
    frame_seq: 0,
    track_id: 't1',
    bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.3 },
    is_near: true,
    is_active_speaker: false,
    crop_jpeg_base64: Buffer.from('a jpeg, as far as this test is concerned').toString('base64'),
    ...overrides,
  }
}

let dataDir: string
let driver: LocalDriver
let service: FaceService
let embed: ReturnType<typeof vi.fn>
let presence: PresenceTracker

const people = () => driver.collection<Person>('people')
const faceprints = () => driver.collection<Faceprint>('faceprints')

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'amelia-faces-test-'))
  driver = await createLocalDriver({ dataDir, fsync: false })
  embed = vi.fn(async () => embeddingOf(MAYA_FACE))
  presence = { seen: vi.fn(), heard: vi.fn(), sweep: vi.fn(), stop: vi.fn() }
  service = createFaceService({
    collections: { people: people(), faceprints: faceprints() },
    bus: new AmeliaBus(),
    embed: embed as unknown as (jpeg: Uint8Array) => Promise<FaceEmbedding>,
    presence,
  })
})

afterEach(async () => {
  await driver.close()
  await rm(dataDir, { recursive: true, force: true })
})

async function knownPerson(name = 'Maya'): Promise<Person> {
  const person: Person = {
    _id: 'p-maya',
    owner_id: OWNER_ID,
    name,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  }
  await people().insertOne(person)
  await faceprints().insertOne({
    _id: 'f-known',
    owner_id: OWNER_ID,
    person_id: person._id,
    embedding: MAYA_FACE,
    quality: 0.9,
    created_at: '2026-01-01T00:00:00.000Z',
  })
  return person
}

/** Frames of one track, so a claim can reach FACE_CONFIRM_FRAMES. */
async function observeFrames(count: number, overrides: Partial<FaceObservationRequest> = {}) {
  let last
  for (let frame = 0; frame < count; frame += 1) {
    last = await service.observe(observation({ ...overrides, frame_seq: frame, frame_ts_ms: frame * 1_000 }))
  }
  return last!
}

describe('a face seen outside a conversation', () => {
  it('is never persisted when we do not know it', async () => {
    embed.mockResolvedValue(embeddingOf(STRANGER_FACE))

    const response = await observeFrames(FACE_CONFIRM_FRAMES + 2)

    expect(response.decision).toBe('unknown')
    expect(await people().find({}).toArray()).toEqual([])
    expect(await faceprints().find({}).toArray()).toEqual([])
    expect(presence.seen).not.toHaveBeenCalled()
  })

  it('touches last_seen_at on somebody we know, and nothing else', async () => {
    await knownPerson()

    const response = await observeFrames(FACE_CONFIRM_FRAMES)

    expect(response).toMatchObject({ decision: 'matched', person_id: 'p-maya', confidence: 'confirmed' })
    const stored = await people().findOne({ _id: 'p-maya' })
    expect(stored?.last_seen_at).toBeDefined()
    expect(stored?.avatar_thumbnail).toBeUndefined()
    expect(await faceprints().find({}).toArray()).toHaveLength(1)
  })

  it('says nothing about who somebody is until the match has held', async () => {
    await knownPerson()

    const response = await observeFrames(FACE_CONFIRM_FRAMES - 1)

    expect(response.decision).toBe('pending')
    expect((await people().findOne({ _id: 'p-maya' }))?.last_seen_at).toBeUndefined()
  })
})

describe('a face seen inside a conversation', () => {
  const inConversation = { conversation_id: 'c1', stream_ms: 0 }

  it('mints one Unnamed person after FACE_CONFIRM_FRAMES unmatched frames', async () => {
    embed.mockResolvedValue(embeddingOf(STRANGER_FACE))

    const early = await observeFrames(FACE_CONFIRM_FRAMES - 1, inConversation)
    expect(early.decision).toBe('pending')
    expect(await people().find({}).toArray()).toEqual([])

    const minted = await observeFrames(1, { ...inConversation, frame_ts_ms: 9_000 })
    expect(minted.decision).toBe('created')

    const stored = await people().find({}).toArray()
    expect(stored).toHaveLength(1)
    expect(stored[0].is_unnamed).toBe(true)
    expect(await faceprints().find({}).toArray()).toHaveLength(1)
  })

  it('does not mint a second person once the track already has one', async () => {
    embed.mockResolvedValue(embeddingOf(STRANGER_FACE))

    await observeFrames(FACE_CONFIRM_FRAMES + 3, inConversation)

    expect(await people().find({}).toArray()).toHaveLength(1)
  })

  it('writes one faceprint per track, not one per frame', async () => {
    await knownPerson()

    await observeFrames(FACE_CONFIRM_FRAMES + 4, inConversation)

    // The enrolled print plus exactly one reinforcement from this track.
    expect(await faceprints().find({}).toArray()).toHaveLength(2)
  })

  it('denormalises the sharpest crop onto the person as their avatar', async () => {
    await knownPerson()

    await observeFrames(FACE_CONFIRM_FRAMES, inConversation)

    const stored = await people().findOne({ _id: 'p-maya' })
    expect(stored?.avatar_thumbnail).toBe(observation().crop_jpeg_base64)
  })
})

describe('crops the matcher should not see', () => {
  it('reports no_face when the sidecar found none', async () => {
    embed.mockRejectedValue(new FaceSidecarError(422, 'no face in this crop'))

    const response = await service.observe(observation({ conversation_id: 'c1' }))

    expect(response.decision).toBe('no_face')
    expect(await people().find({}).toArray()).toEqual([])
  })

  it('refuses a crop the detector is unsure of, which is the one most likely to match the wrong person', async () => {
    embed.mockResolvedValue(embeddingOf(MAYA_FACE, FACE_MIN_DET_SCORE - 0.01))
    await knownPerson()

    const response = await observeFrames(FACE_CONFIRM_FRAMES, { conversation_id: 'c1' })

    expect(response.decision).toBe('no_face')
    expect((await people().findOne({ _id: 'p-maya' }))?.last_seen_at).toBeUndefined()
  })

  it('lets a sidecar failure through rather than reporting it as an absent face', async () => {
    embed.mockRejectedValue(new FaceSidecarError(500, 'sidecar is unwell'))

    await expect(service.observe(observation())).rejects.toThrow('sidecar is unwell')
  })
})

describe('storing a faceprint', () => {
  it('refuses a request without a conversation_id', () => {
    expect(() => conversationForStorage({})).toThrow('only be stored inside a conversation')
    expect(conversationForStorage({ conversation_id: 'c1' })).toBe('c1')
  })
})

describe('after a merge', () => {
  it('re-points the loser faceprints at the survivor and refreshes their avatar', async () => {
    await knownPerson()
    await faceprints().insertOne({
      _id: 'f-duplicate',
      owner_id: OWNER_ID,
      person_id: 'p-duplicate',
      embedding: MAYA_FACE,
      quality: 0.99,
      thumbnail: 'the sharper crop',
      created_at: '2026-01-02T00:00:00.000Z',
    })

    await service.repointFaceprints(['p-duplicate'], 'p-maya')

    expect(await faceprints().find({ person_id: 'p-duplicate' }).toArray()).toEqual([])
    expect(await faceprints().find({ person_id: 'p-maya' }).toArray()).toHaveLength(2)
    expect((await people().findOne({ _id: 'p-maya' }))?.avatar_thumbnail).toBe('the sharper crop')
  })
})
