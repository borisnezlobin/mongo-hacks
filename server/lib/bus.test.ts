import { describe, expect, it, vi } from 'vitest';
import type { UtteranceEvent } from '../../shared/contracts';
import { AmeliaBus } from './bus';

describe('AmeliaBus', () => {
  it('publishes full typed payloads and unsubscribes cleanly', () => {
    const bus = new AmeliaBus();
    const listener = vi.fn();
    const unsubscribe = bus.subscribe(listener);
    const event: UtteranceEvent = {
      type: 'utterance',
      utterance_id: 'u-test',
      conversation_id: 'c-test',
      text: 'Test utterance',
      start_ms: 0,
      end_ms: 3_200,
      is_final: true,
    };

    bus.emit(event);
    unsubscribe();
    bus.emit({ ...event, text: 'Revised text' });

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(event);
  });
});
