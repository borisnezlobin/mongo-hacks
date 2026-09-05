/**
 * The face lane: a crop arrives, and the only questions are who it is and what
 * — if anything — we are allowed to write down about it.
 *
 * The privacy rule is the shape of this file. The camera polls whenever the
 * glasses are connected, and looking at somebody is not consent to record them,
 * so outside a conversation the service matches the crop, may say who it is,
 * and touches exactly one field on exactly one existing person. It mints
 * nobody, stores no faceprint, keeps no thumbnail, and an unrecognised face
 * leaves no trace at all. Inside a conversation it behaves like the voice path:
 * an unknown that holds still for FACE_CONFIRM_FRAMES earns a person.
 */

import type {
  FaceClaim,
  FaceObservationRequest,
  FaceObservationResponse,
  Faceprint,
  Id,
  Person,
  ServerDependencies,
} from '../../shared/contracts'
import {
  FACE_CONFIRM_FRAMES,
  FACE_MIN_DET_SCORE,
  MAX_FACEPRINTS_PER_PERSON,
  OWNER_ID,
} from '../../shared/contracts'
import type { AmeliaBus } from '../lib/bus'
import { UNNAMED_PERSON_NAME } from '../identity'
import type { Decision } from '../identity/matcher'
import { getStorage } from '../storage'
import type { StorageCollection } from '../storage'
import { embedFaceJpeg, isNoFace, type FaceEmbedding } from './embed-client'
import { decideFace, scoreFaces, selectWeakestFaceprints } from './matcher'
import { presenceTrackerFor, type PresenceTracker } from './presence'
import { FaceTrackLedger, type Span, type TrackState } from './tracks'

export type FaceEmbedder = (jpeg: Uint8Array) => Promise<FaceEmbedding>

export interface FaceServiceOptions {
  collections: {
    people: StorageCollection<Person>
    faceprints: StorageCollection<Faceprint>
  }
  bus: AmeliaBus
  embed: FaceEmbedder
  presence: PresenceTracker
  now?: () => Date
}

export interface FaceService {
  observe(request: FaceObservationRequest): Promise<FaceObservationResponse>
  /** What the face lane can say about a stretch of one conversation's audio. */
  claimsFor(conversationId: Id | undefined, spans: readonly Span[]): FaceClaim[]
  /** A voice vouched for this face: store it against a person we already know. */
  attachFaceToPerson(personId: Id, print: Omit<Faceprint, '_id' | 'owner_id' | 'person_id' | 'created_at'>): Promise<Id>
  /** Point a merged person's faceprints at the survivor. Never deletes. */
  repointFaceprints(loserIds: readonly Id[], survivorId: Id): Promise<void>
}

export function createFaceService(options: FaceServiceOptions): FaceService {
  const { collections, embed, presence } = options
  const timestamp = () => (options.now?.() ?? new Date()).toISOString()
  const ledger = new FaceTrackLedger()

  /** Every faceprint whose person still exists; orphans outlive a merge. */
  const livePrints = async (): Promise<{ prints: Faceprint[]; people: Map<Id, Person> }> => {
    const prints = await collections.faceprints.find({ owner_id: OWNER_ID }).toArray()
    const people = await collections.people.find({ owner_id: OWNER_ID }).toArray()
    const byId = new Map(people.map((person) => [person._id, person]))
    return { prints: prints.filter((print) => byId.has(print.person_id)), people: byId }
  }

  /**
   * The one write the idle path may make. Recognising a familiar face across a
   * room is worth remembering even though nothing was recorded, and it is what
   * the presence card's "saw them yesterday" reads back.
   */
  const touchLastSeen = async (personId: Id): Promise<void> => {
    await collections.people.updateOne(
      { _id: personId, owner_id: OWNER_ID },
      { $set: { last_seen_at: timestamp() } },
    )
  }

  const insertPrint = async (print: Faceprint): Promise<void> => {
    await collections.faceprints.insertOne(print)
    const existing = await collections.faceprints
      .find({ owner_id: OWNER_ID, person_id: print.person_id })
      .toArray()
    // The print just inserted never competes for its own eviction: callers are
    // handed its id, and the weakest-first order would otherwise delete a fresh
    // print of somebody whose existing ones are all sharper.
    const others = existing.filter((candidate) => candidate._id !== print._id)
    const doomed = selectWeakestFaceprints(others, MAX_FACEPRINTS_PER_PERSON - 1)
    if (doomed.length > 0) {
      await collections.faceprints.deleteMany({ _id: { $in: doomed }, owner_id: OWNER_ID })
    }
  }

  /**
   * Write a face down. Refuses outright without a conversation.
   *
   * This is asserted here rather than checked at the call sites because it is
   * the whole privacy promise of the idle path, and a promise enforced only by
   * the discipline of its callers is one bad merge away from being untrue.
   */
  const storeFaceprint = async (
    personId: Id,
    request: FaceObservationRequest,
    embedding: FaceEmbedding,
  ): Promise<Id> => {
    const conversationId = conversationForStorage(request)
    const print: Faceprint = {
      _id: crypto.randomUUID(),
      owner_id: OWNER_ID,
      person_id: personId,
      embedding: embedding.vector,
      quality: embedding.det_score,
      source_conversation_id: conversationId,
      source_frame_ts: request.frame_ts_ms,
      thumbnail: request.crop_jpeg_base64,
      created_at: timestamp(),
    }
    await insertPrint(print)
    return print._id
  }

  /**
   * Denormalise the sharpest crop we hold onto the person.
   *
   * Every screen that lists people wants an avatar, and `GET /people` is the
   * call they all already make; hydrating thumbnails per screen would be a
   * request each to show something the row cannot render without.
   */
  const refreshAvatarThumbnail = async (personId: Id): Promise<void> => {
    const prints = await collections.faceprints.find({ owner_id: OWNER_ID, person_id: personId }).toArray()
    const best = prints
      .filter((print) => Boolean(print.thumbnail))
      .sort((left, right) => right.quality - left.quality)[0]
    if (!best?.thumbnail) return
    await collections.people.updateOne(
      { _id: personId, owner_id: OWNER_ID },
      { $set: { avatar_thumbnail: best.thumbnail, updated_at: timestamp() } },
    )
  }

  const mintUnnamedPerson = async (): Promise<Person> => {
    const now = timestamp()
    const person: Person = {
      _id: crypto.randomUUID(),
      owner_id: OWNER_ID,
      name: UNNAMED_PERSON_NAME,
      is_unnamed: true,
      created_at: now,
      updated_at: now,
    }
    await collections.people.insertOne(person)
    return person
  }

  const applyMatched = async (
    request: FaceObservationRequest,
    embedding: FaceEmbedding,
    decision: Extract<Decision, { status: 'matched' }>,
    person: Person,
    track: TrackState,
  ): Promise<FaceObservationResponse> => {
    const confidence = confidenceOf(track)
    presence.seen({
      conversation_id: request.conversation_id,
      person_id: person._id,
      name: person.name,
      confidence,
      is_near: request.is_near,
      speaking: request.is_active_speaker,
    })
    if (confidence !== 'confirmed') {
      return { track_id: request.track_id, decision: 'pending', confidence, person_id: person._id, score: decision.score }
    }

    await touchLastSeen(person._id)
    let faceprintId: Id | undefined
    if (request.conversation_id && !track.reinforced) {
      faceprintId = await storeFaceprint(person._id, request, embedding)
      ledger.markReinforced(request.conversation_id, request.track_id)
      await refreshAvatarThumbnail(person._id)
    }
    return {
      track_id: request.track_id,
      decision: 'matched',
      person_id: person._id,
      name: person.name,
      confidence,
      score: decision.score,
      ...(faceprintId ? { faceprint_id: faceprintId } : {}),
    }
  }

  /**
   * A face nobody knows, inside a conversation. It earns a person only once it
   * has held still for FACE_CONFIRM_FRAMES — a stranger glimpsed once in a
   * doorway is how the people list fills with ghosts.
   */
  const applyUnknown = async (
    request: FaceObservationRequest,
    embedding: FaceEmbedding,
    track: TrackState,
  ): Promise<FaceObservationResponse> => {
    if (track.unmatched < FACE_CONFIRM_FRAMES) {
      return { track_id: request.track_id, decision: 'pending', confidence: 'pending' }
    }
    const person = await mintUnnamedPerson()
    const faceprintId = await storeFaceprint(person._id, request, embedding)
    ledger.markReinforced(request.conversation_id, request.track_id)
    await refreshAvatarThumbnail(person._id)
    await touchLastSeen(person._id)
    presence.seen({
      conversation_id: request.conversation_id,
      person_id: person._id,
      name: person.name,
      confidence: 'confirmed',
      is_near: request.is_near,
      speaking: request.is_active_speaker,
    })
    return {
      track_id: request.track_id,
      decision: 'created',
      person_id: person._id,
      name: person.name,
      confidence: 'confirmed',
      faceprint_id: faceprintId,
    }
  }

  /** A face nobody knows, outside a conversation. Nothing happens, and that is the feature. */
  const applyUnknownIdle = (request: FaceObservationRequest): FaceObservationResponse => ({
    track_id: request.track_id,
    decision: 'unknown',
    confidence: 'pending',
  })

  const observeCrop = async (
    request: FaceObservationRequest,
    embedding: FaceEmbedding,
  ): Promise<FaceObservationResponse> => {
    const { prints, people } = await livePrints()
    const decision = decideFace(scoreFaces(embedding.vector, prints), {
      taken: ledger.confirmedElsewhere(request.conversation_id, request.track_id),
    })
    const matchedPerson = decision.status === 'matched' ? people.get(decision.person_id) : undefined
    const track = ledger.observe(request.conversation_id, {
      track_id: request.track_id,
      ...(matchedPerson ? { person_id: matchedPerson._id } : {}),
      score: decision.score,
      frame_ts_ms: request.frame_ts_ms,
      ...(request.stream_ms === undefined ? {} : { stream_ms: request.stream_ms }),
      is_near: request.is_near,
      is_active_speaker: request.is_active_speaker,
    })

    if (decision.status === 'matched' && matchedPerson) {
      return applyMatched(request, embedding, decision, matchedPerson, track)
    }
    if (decision.status === 'ambiguous') {
      return { track_id: request.track_id, decision: 'ambiguous', confidence: 'pending', score: decision.score }
    }
    if (!request.conversation_id) return applyUnknownIdle(request)
    return applyUnknown(request, embedding, track)
  }

  return {
    async observe(request) {
      const crop = decodeCrop(request.crop_jpeg_base64)
      if (crop.byteLength === 0) {
        return { track_id: request.track_id, decision: 'no_face', confidence: 'pending' }
      }
      let embedding: FaceEmbedding
      try {
        embedding = await embed(crop)
      } catch (error) {
        if (isNoFace(error)) {
          return { track_id: request.track_id, decision: 'no_face', confidence: 'pending' }
        }
        throw error
      }
      // A crop the detector is unsure of is worse than no crop: it is the one
      // most likely to match somebody it is not.
      if (embedding.det_score < FACE_MIN_DET_SCORE) {
        return { track_id: request.track_id, decision: 'no_face', confidence: 'pending' }
      }
      return observeCrop(request, embedding)
    },

    claimsFor(conversationId, spans) {
      return ledger.claimsOverlapping(conversationId, spans)
    },

    async attachFaceToPerson(personId, print) {
      const stored: Faceprint = {
        ...print,
        _id: crypto.randomUUID(),
        owner_id: OWNER_ID,
        person_id: personId,
        created_at: timestamp(),
      }
      await insertPrint(stored)
      await refreshAvatarThumbnail(personId)
      return stored._id
    },

    async repointFaceprints(loserIds, survivorId) {
      if (loserIds.length === 0) return
      await collections.faceprints.updateMany(
        { owner_id: OWNER_ID, person_id: { $in: [...loserIds] } },
        { $set: { person_id: survivorId } },
      )
      await refreshAvatarThumbnail(survivorId)
    },
  }
}

/**
 * The privacy assertion behind every faceprint write.
 *
 * Exported so it can be tested as itself: it is the whole promise of the idle
 * path, and a promise enforced only by the discipline of its callers is one
 * refactor away from being untrue.
 */
export function conversationForStorage(request: Pick<FaceObservationRequest, 'conversation_id'>): Id {
  if (!request.conversation_id) {
    throw new Error('a faceprint may only be stored inside a conversation')
  }
  return request.conversation_id
}

function confidenceOf(track: TrackState): FaceObservationResponse['confidence'] {
  if (track.consecutive >= FACE_CONFIRM_FRAMES) return 'confirmed'
  return track.consecutive > 0 ? 'provisional' : 'pending'
}

function decodeCrop(base64: string): Uint8Array {
  if (!base64) return new Uint8Array()
  try {
    return Uint8Array.from(Buffer.from(base64, 'base64'))
  } catch {
    return new Uint8Array()
  }
}

/**
 * One face service per bus, like `identityServiceFor`.
 *
 * The ledger and the presence tracker are process state, so a second service
 * against the same bus would count frames twice and announce people twice.
 */
const servicesByBus = new WeakMap<object, Promise<FaceService>>()

export function faceServiceFor(deps: ServerDependencies): Promise<FaceService> {
  const bus = deps.bus as AmeliaBus
  const existing = servicesByBus.get(bus)
  if (existing) return existing
  const created = (async () => {
    const storage = await getStorage()
    return createFaceService({
      collections: {
        people: storage.collection<Person>('people'),
        faceprints: storage.collection<Faceprint>('faceprints'),
      },
      bus,
      embed: embedFaceJpeg,
      presence: presenceTrackerFor(bus),
    })
  })()
  servicesByBus.set(bus, created)
  return created.catch((error: unknown) => {
    servicesByBus.delete(bus)
    throw error
  })
}
