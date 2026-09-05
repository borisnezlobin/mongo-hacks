import { describe, expect, it } from 'vitest';
import type { AmeliaEvent, BusEventName } from '../../../shared/contracts';
import { EVENT_NAMES } from './event-names';

/**
 * The union, restated once so the compiler checks the list against it. Adding a
 * member to AmeliaEvent without adding it here is a type error, not a silent
 * event nobody receives.
 */
const EVERY_EVENT: Record<AmeliaEvent['type'], true> = {
  utterance: true,
  identity: true,
  identity_conflict: true,
  presence: true,
  speaker_pending: true,
  name_suggestion: true,
  conversation: true,
  fact: true,
  promise: true,
  amelia_step: true,
  amelia_audio: true,
};

describe('event names', () => {
  it('subscribes to every event on the bus', () => {
    const expected = Object.keys(EVERY_EVENT) as BusEventName[];
    expect([...EVENT_NAMES].sort()).toEqual([...expected].sort());
  });

  it('names each event once', () => {
    expect(new Set(EVENT_NAMES).size).toBe(EVENT_NAMES.length);
  });
});
