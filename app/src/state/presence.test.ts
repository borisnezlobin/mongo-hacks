import { describe, expect, it } from 'vitest';
import { PRESENCE_TTL_MS, type PresenceEvent } from '../../../shared/contracts';
import { applyPresenceEvent, initialPresenceState, sweepPresence } from './presence';

const event = (overrides: Partial<PresenceEvent> = {}): PresenceEvent => ({
  type: 'presence',
  person_id: 'p-1',
  name: 'Maya',
  confidence: 'confirmed',
  source: 'face',
  speaking: false,
  is_near: true,
  track_state: 'present',
  ...overrides,
});

describe('presence', () => {
  it('puts somebody in the room with an expiry', () => {
    const state = applyPresenceEvent(initialPresenceState, event(), 1_000);
    expect(state['p-1'].name).toBe('Maya');
    expect(state['p-1'].expires_at).toBe(1_000 + PRESENCE_TTL_MS);
  });

  it('a later event pushes the expiry out', () => {
    let state = applyPresenceEvent(initialPresenceState, event(), 0);
    state = applyPresenceEvent(state, event({ speaking: true }), 5_000);
    expect(state['p-1'].speaking).toBe(true);
    expect(state['p-1'].expires_at).toBe(5_000 + PRESENCE_TTL_MS);
  });

  /** Leaving frame is not "hide the card now": a glance should still catch it. */
  it('keeps a lost person for the full window, then sweeps them', () => {
    const state = applyPresenceEvent(initialPresenceState, event({ track_state: 'lost' }), 0);
    expect(sweepPresence(state, PRESENCE_TTL_MS - 1)['p-1']).toBeDefined();
    expect(sweepPresence(state, PRESENCE_TTL_MS + 1)['p-1']).toBeUndefined();
  });

  it('keeps timestamps it already had when an event omits them', () => {
    let state = applyPresenceEvent(initialPresenceState, event({ last_heard_at: '2026-01-01T00:00:00.000Z' }), 0);
    state = applyPresenceEvent(state, event(), 1_000);
    expect(state['p-1'].last_heard_at).toBe('2026-01-01T00:00:00.000Z');
  });

  it('returns the same object when nobody expired', () => {
    const state = applyPresenceEvent(initialPresenceState, event(), 0);
    expect(sweepPresence(state, 100)).toBe(state);
  });
});
