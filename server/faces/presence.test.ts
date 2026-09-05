import { describe, expect, it } from 'vitest'
import type { AmeliaEvent, PresenceEvent } from '../../shared/contracts'
import { PRESENCE_TTL_MS } from '../../shared/contracts'
import { AmeliaBus } from '../lib/bus'
import { createPresenceTracker, registerPresence } from './presence'

function harness() {
  const bus = new AmeliaBus()
  const events: PresenceEvent[] = []
  bus.subscribe((event: AmeliaEvent) => {
    if (event.type === 'presence') events.push(event)
  })
  let clock = 1_000
  const tracker = createPresenceTracker(bus, {
    now: () => clock,
    setTimer: () => undefined,
    clearTimer: () => undefined,
  })
  return { bus, events, tracker, advance: (ms: number) => (clock += ms) }
}

const maya = { person_id: 'p-maya', name: 'Maya', confidence: 'confirmed' as const, is_near: true, speaking: false }

describe('announcing who is in the room', () => {
  it('emits once when somebody appears, and stays quiet while nothing changes', () => {
    const { events, tracker, advance } = harness()

    tracker.seen({ ...maya })
    advance(1_000)
    tracker.seen({ ...maya })
    advance(1_000)
    tracker.seen({ ...maya })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ person_id: 'p-maya', source: 'face', track_state: 'present' })
  })

  it('emits again when something the card would redraw changes', () => {
    const { events, tracker, advance } = harness()
    tracker.seen({ ...maya })
    advance(1_000)

    tracker.seen({ ...maya, speaking: true })

    expect(events).toHaveLength(2)
    expect(events[1].speaking).toBe(true)
  })

  it('holds a second change inside 500 ms until the next sweep', () => {
    const { events, tracker, advance } = harness()
    tracker.seen({ ...maya })

    advance(100)
    tracker.seen({ ...maya, speaking: true })
    expect(events).toHaveLength(1)

    advance(600)
    tracker.sweep()
    expect(events).toHaveLength(2)
    expect(events[1].speaking).toBe(true)
  })

  it('says the source is both once a face and a voice agree', () => {
    const { events, tracker, advance } = harness()
    tracker.seen({ ...maya })
    advance(1_000)

    tracker.heard({ person_id: 'p-maya', name: 'Maya', confidence: 'confirmed' })

    expect(events[1].source).toBe('both')
  })

  it('reports somebody lost once the TTL passes with nothing from them', () => {
    const { events, tracker, advance } = harness()
    tracker.seen({ ...maya, speaking: true })

    advance(PRESENCE_TTL_MS + 1)
    tracker.sweep()

    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({ track_state: 'lost', speaking: false, is_near: false })
  })

  it('keeps somebody in the room while they are still talking', () => {
    const { events, tracker, advance } = harness()
    tracker.seen({ ...maya })

    advance(PRESENCE_TTL_MS - 1_000)
    tracker.heard({ person_id: 'p-maya' })
    advance(2_000)
    tracker.sweep()

    expect(events.some((event) => event.track_state === 'lost')).toBe(false)
  })

  it('does not announce a voice it has no name for', () => {
    const { events, tracker } = harness()

    tracker.heard({ person_id: 'p-stranger' })

    expect(events).toHaveLength(0)
  })
})

describe('the voice half of presence', () => {
  it('puts somebody in the room on an identity event and keeps them there on their turns', () => {
    const bus = new AmeliaBus()
    const events: PresenceEvent[] = []
    bus.subscribe((event) => {
      if (event.type === 'presence') events.push(event)
    })
    const unsubscribe = registerPresence(bus, { setTimer: () => undefined, clearTimer: () => undefined })

    bus.emit({
      type: 'identity',
      conversation_id: 'c1',
      person_id: 'p-maya',
      name: 'Maya',
      utterance_ids: ['u1'],
      confidence: 'confirmed',
    })
    bus.emit({
      type: 'utterance',
      utterance_id: 'u2',
      conversation_id: 'c1',
      person_id: 'p-maya',
      text: 'still here',
      start_ms: 0,
      end_ms: 1_000,
      is_final: true,
    })
    unsubscribe()

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ person_id: 'p-maya', name: 'Maya', source: 'voice', conversation_id: 'c1' })
  })
})
