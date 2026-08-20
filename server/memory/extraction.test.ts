import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AmeliaEvent, Utterance } from '../../shared/contracts';
import { WINDOW_MAX_WAIT_MS } from './window';

const mocks = vi.hoisted(() => ({
  runWindowPass: vi.fn(async () => true),
  runSlowPass: vi.fn(async () => undefined),
  upsertUtterance: vi.fn(async () => undefined),
  stored: new Map<string, Utterance>(),
}));

vi.mock('./passes', () => ({ runWindowPass: mocks.runWindowPass, runSlowPass: mocks.runSlowPass }));
vi.mock('./store', () => ({ upsertUtterance: mocks.upsertUtterance }));
vi.mock('./db', () => ({
  collections: {
    utterances: () => ({ findOne: async ({ _id }: { _id: string }) => mocks.stored.get(_id) ?? null }),
  },
}));

import { registerExtraction } from './extraction';

class TestBus {
  private listeners: Array<(event: AmeliaEvent) => void> = [];
  emit = vi.fn((event: AmeliaEvent) => {
    for (const listener of this.listeners) listener(event);
  });
  subscribe = (listener: (event: AmeliaEvent) => void) => {
    this.listeners.push(listener);
    return () => undefined;
  };
}

let bus: TestBus;
let unsubscribe: () => void;
let sequence = 0;
/** Module-level per-conversation state is real, so every test gets its own conversation. */
let conversationId = 'c-0';

function speak(text: string, personId = 'p-maya', identityConfidence: 'pending' | 'provisional' | 'confirmed' = 'confirmed'): void {
  sequence += 1;
  const utteranceId = `u-${sequence}`;
  mocks.stored.set(utteranceId, {
    _id: utteranceId,
    owner_id: 'owner',
    conversation_id: conversationId,
    person_id: personId,
    identity_confidence: identityConfidence,
    text,
    start_ms: sequence * 1_000,
    end_ms: sequence * 1_000 + 800,
    is_final: true,
    created_at: '2026-08-17T00:00:00Z',
    updated_at: '2026-08-17T00:00:00Z',
  });
  bus.emit({
    type: 'utterance',
    utterance_id: utteranceId,
    conversation_id: conversationId,
    person_id: personId,
    identity_confidence: identityConfidence,
    text,
    start_ms: sequence * 1_000,
    end_ms: sequence * 1_000 + 800,
    is_final: true,
  });
}

/** Let the per-conversation chain settle; each turn queues a couple of microtasks. */
async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  mocks.stored.clear();
  bus = new TestBus();
  sequence += 1;
  conversationId = `c-${sequence}`;
  unsubscribe = registerExtraction(bus as never);
});

afterEach(() => {
  unsubscribe();
  vi.useRealTimers();
});

const SENTENCE = 'I moved into this building in August and my whole family is still back home in Ohio.';

describe('batched extraction', () => {
  it('does not spend a call per finalized turn', async () => {
    for (let index = 0; index < 40; index += 1) speak('Yeah.');
    await settle();

    expect(mocks.runWindowPass).not.toHaveBeenCalled();
  });

  it('extracts once for a window of many turns rather than once per turn', async () => {
    for (let index = 0; index < 60; index += 1) speak(SENTENCE);
    await settle();

    expect(mocks.runWindowPass).toHaveBeenCalled();
    expect(mocks.runWindowPass.mock.calls.length).toBeLessThan(10);
    const [firstCall] = mocks.runWindowPass.mock.calls as unknown as Array<[unknown, Utterance[]]>;
    expect(firstCall?.[1].length).toBeGreaterThan(10);
  });

  it('extracts during the conversation rather than only at the end', async () => {
    speak(SENTENCE);
    speak('My sister is at the state school down the coast studying marine biology.');
    await settle();
    expect(mocks.runWindowPass).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(WINDOW_MAX_WAIT_MS + 10);
    await settle();

    expect(mocks.runWindowPass).toHaveBeenCalledTimes(1);
  });

  it('leaves the timer idle when the only thing said was backchannel', async () => {
    speak('Yeah.');
    speak('Oh okay');
    await settle();
    await vi.advanceTimersByTimeAsync(WINDOW_MAX_WAIT_MS * 3);
    await settle();

    expect(mocks.runWindowPass).not.toHaveBeenCalled();
  });

  it('carries the identity confidence onto the stored utterance', async () => {
    speak(SENTENCE, 'p-maya', 'provisional');
    await settle();

    expect(mocks.upsertUtterance).toHaveBeenCalledWith(
      expect.objectContaining({ identity_confidence: 'provisional' }),
    );
  });

  it('still records every utterance it declines to extract from', async () => {
    for (let index = 0; index < 5; index += 1) speak('Yeah.');
    await settle();

    expect(mocks.upsertUtterance).toHaveBeenCalledTimes(5);
  });
});
