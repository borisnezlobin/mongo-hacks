/**
 * Who is in the room, debounced down to something the bus can carry.
 *
 * Face observations arrive several times a second per track. The bus keeps a
 * 4,096-event replay buffer and drops SSE clients that fall 256 events behind,
 * so putting them on it would evict a conversation's real history within
 * seconds of somebody walking in. This is the one summary that goes out, and it
 * goes out only when something the UI would actually redraw has changed.
 *
 * Presence is fed by both identifiers. A face in frame and a voice on a turn
 * are the same fact about the same person arriving through different doors, so
 * `seen` and `heard` write into one record and the event says which door, or
 * both.
 */

import type { AmeliaEvent, Id, IdentityConfidence, IdentitySource, PresenceEvent } from '../../shared/contracts'
import { PRESENCE_TTL_MS } from '../../shared/contracts'
import type { AmeliaBus } from '../lib/bus'

/**
 * Floor between two events about one person.
 *
 * A face that flickers in and out of the active-speaker score would otherwise
 * emit on every frame, and the card it drives cannot usefully change twice a
 * second anyway. Suppressed changes are not lost: the state is kept and the
 * next sweep flushes it.
 */
const MIN_EVENT_INTERVAL_MS = 500

/** How often the tracker wakes itself to expire people who have left. */
const SWEEP_INTERVAL_MS = 1_000

export interface PresenceSighting {
  conversation_id?: Id
  person_id: Id
  name: string
  confidence: IdentityConfidence
  is_near: boolean
  speaking: boolean
}

export interface PresenceHearing {
  conversation_id?: Id
  person_id: Id
  /** Absent on an utterance, which carries a person and no name. */
  name?: string
  confidence?: IdentityConfidence
}

export interface PresenceTracker {
  seen(sighting: PresenceSighting): void
  heard(hearing: PresenceHearing): void
  /** Expire anyone past PRESENCE_TTL_MS and flush changes the rate limit held back. */
  sweep(): void
  stop(): void
}

export interface PresenceOptions {
  now?: () => number
  setTimer?: (callback: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

interface PresenceRecord {
  conversation_id?: Id
  person_id: Id
  name: string
  confidence: IdentityConfidence
  seen_by_face: boolean
  heard_by_voice: boolean
  speaking: boolean
  is_near: boolean
  last_seen_at?: number
  last_heard_at?: number
  last_activity_at: number
  last_emit_at: number
  emitted?: string
}

function sourceOf(record: PresenceRecord): IdentitySource {
  if (record.seen_by_face && record.heard_by_voice) return 'both'
  return record.seen_by_face ? 'face' : 'voice'
}

function eventFor(record: PresenceRecord, state: PresenceEvent['track_state']): PresenceEvent {
  return {
    type: 'presence',
    ...(record.conversation_id ? { conversation_id: record.conversation_id } : {}),
    person_id: record.person_id,
    name: record.name,
    confidence: record.confidence,
    source: sourceOf(record),
    speaking: state === 'lost' ? false : record.speaking,
    is_near: state === 'lost' ? false : record.is_near,
    track_state: state,
    ...(record.last_seen_at ? { last_seen_at: new Date(record.last_seen_at).toISOString() } : {}),
    ...(record.last_heard_at ? { last_heard_at: new Date(record.last_heard_at).toISOString() } : {}),
  }
}

/** What the UI would redraw. Timestamps are excluded on purpose: they always differ. */
function signature(event: PresenceEvent): string {
  return [
    event.conversation_id ?? '',
    event.name,
    event.confidence,
    event.source,
    String(event.speaking),
    String(event.is_near),
    event.track_state,
  ].join('|')
}

export function createPresenceTracker(bus: AmeliaBus, options: PresenceOptions = {}): PresenceTracker {
  const now = () => options.now?.() ?? Date.now()
  const setTimer = options.setTimer ?? defaultSetTimer
  const clearTimer = options.clearTimer ?? defaultClearTimer
  const present = new Map<Id, PresenceRecord>()
  let sweepHandle: unknown

  const recordFor = (personId: Id, name: string): PresenceRecord => {
    const existing = present.get(personId)
    if (existing) return existing
    const created: PresenceRecord = {
      person_id: personId,
      name,
      confidence: 'pending',
      seen_by_face: false,
      heard_by_voice: false,
      speaking: false,
      is_near: false,
      last_activity_at: now(),
      last_emit_at: Number.NEGATIVE_INFINITY,
    }
    present.set(personId, created)
    return created
  }

  const publish = (record: PresenceRecord): void => {
    const event = eventFor(record, 'present')
    const next = signature(event)
    if (next === record.emitted) return
    if (now() - record.last_emit_at < MIN_EVENT_INTERVAL_MS) return
    record.emitted = next
    record.last_emit_at = now()
    bus.emit(event)
  }

  const scheduleSweep = (): void => {
    if (sweepHandle !== undefined) return
    sweepHandle = setTimer(() => {
      sweepHandle = undefined
      tracker.sweep()
      if (present.size > 0) scheduleSweep()
    }, SWEEP_INTERVAL_MS)
  }

  const tracker: PresenceTracker = {
    seen(sighting) {
      const record = recordFor(sighting.person_id, sighting.name)
      record.name = sighting.name
      record.confidence = sighting.confidence
      record.conversation_id = sighting.conversation_id
      record.seen_by_face = true
      record.speaking = sighting.speaking
      record.is_near = sighting.is_near
      record.last_seen_at = now()
      record.last_activity_at = now()
      publish(record)
      scheduleSweep()
    },

    /**
     * A voice on a turn. An utterance carries no name, so somebody heard before
     * they were ever seen or identified is not announced — there is nothing to
     * put on the card yet, and inventing a placeholder name is how a person
     * ends up in the room twice.
     */
    heard(hearing) {
      const known = present.get(hearing.person_id)
      if (!known && !hearing.name) return
      const record = recordFor(hearing.person_id, hearing.name ?? known?.name ?? '')
      if (hearing.name) record.name = hearing.name
      if (hearing.confidence) record.confidence = hearing.confidence
      if (hearing.conversation_id) record.conversation_id = hearing.conversation_id
      record.heard_by_voice = true
      record.last_heard_at = now()
      record.last_activity_at = now()
      publish(record)
      scheduleSweep()
    },

    sweep() {
      const cutoff = now() - PRESENCE_TTL_MS
      for (const [personId, record] of present) {
        if (record.last_activity_at >= cutoff) {
          publish(record)
          continue
        }
        present.delete(personId)
        bus.emit(eventFor(record, 'lost'))
      }
    },

    stop() {
      if (sweepHandle !== undefined) clearTimer(sweepHandle)
      sweepHandle = undefined
      present.clear()
    },
  }

  return tracker
}

function defaultSetTimer(callback: () => void, ms: number): unknown {
  const handle = setTimeout(callback, ms)
  // Presence must never be the reason a process refuses to exit.
  ;(handle as unknown as { unref?: () => void }).unref?.()
  return handle
}

function defaultClearTimer(handle: unknown): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>)
}

/**
 * One tracker per bus.
 *
 * The face service and the bus listener below are two doors into the same
 * record: a person seen and then heard has to come out as `source: 'both'`,
 * which is impossible if each side keeps its own map.
 */
const trackersByBus = new WeakMap<object, PresenceTracker>()

export function presenceTrackerFor(bus: AmeliaBus, options: PresenceOptions = {}): PresenceTracker {
  const existing = trackersByBus.get(bus)
  if (existing) return existing
  const created = createPresenceTracker(bus, options)
  trackersByBus.set(bus, created)
  return created
}

/**
 * Feed presence from the voice side. Faces come in through the face service.
 *
 * `identity` carries the name and the confidence, so it is what puts somebody
 * in the room; a final `utterance` afterwards is only proof they are still
 * there, which is exactly what the TTL needs and all it needs.
 */
export function registerPresence(bus: AmeliaBus, options: PresenceOptions = {}): () => void {
  const tracker = presenceTrackerFor(bus, options)
  const handle = (event: AmeliaEvent): void => {
    if (event.type === 'identity') {
      tracker.heard({
        conversation_id: event.conversation_id,
        person_id: event.person_id,
        name: event.name,
        confidence: event.confidence,
      })
      return
    }
    if (event.type === 'utterance' && event.is_final && event.person_id) {
      tracker.heard({ conversation_id: event.conversation_id, person_id: event.person_id })
    }
  }
  return bus.subscribe(handle)
}
