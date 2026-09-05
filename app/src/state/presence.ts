/**
 * Who is in the room right now.
 *
 * Separate from `people` because it is not a fact about a person, it is a fact
 * about the last few seconds. A presence entry expires on its own: somebody who
 * walked out of frame and stopped talking is gone fifteen seconds later whether
 * or not anything tells us so, which is what stops a card hanging around
 * announcing a person who left the building.
 */

import { PRESENCE_TTL_MS, type Id, type PresenceEvent } from '../../../shared/contracts';

export interface PresenceRecord {
  person_id: Id;
  name: string;
  confidence: PresenceEvent['confidence'];
  source: PresenceEvent['source'];
  speaking: boolean;
  is_near: boolean;
  conversation_id?: Id;
  last_seen_at?: string;
  last_heard_at?: string;
  /** Epoch ms after which this person is no longer in the room. */
  expires_at: number;
}

export type PresenceState = Record<Id, PresenceRecord>;

export const initialPresenceState: PresenceState = {};

/**
 * Every event, present or lost, pushes the expiry out by the full window. A
 * 'lost' event is not "hide this now" — it is "they left frame", and the card
 * is meant to outlive that by fifteen seconds so a glance still catches it.
 */
export function applyPresenceEvent(state: PresenceState, event: PresenceEvent, now: number): PresenceState {
  const record: PresenceRecord = {
    person_id: event.person_id,
    name: event.name,
    confidence: event.confidence,
    source: event.source,
    speaking: event.speaking,
    is_near: event.is_near,
    conversation_id: event.conversation_id,
    last_seen_at: event.last_seen_at ?? state[event.person_id]?.last_seen_at,
    last_heard_at: event.last_heard_at ?? state[event.person_id]?.last_heard_at,
    expires_at: now + PRESENCE_TTL_MS,
  };
  return { ...state, [event.person_id]: record };
}

/** Returns the same object when nothing expired, so an idle sweep wakes nobody. */
export function sweepPresence(state: PresenceState, now: number): PresenceState {
  const kept: PresenceState = {};
  let dropped = false;
  for (const [id, record] of Object.entries(state)) {
    if (record.expires_at > now) kept[id] = record;
    else dropped = true;
  }
  return dropped ? kept : state;
}
