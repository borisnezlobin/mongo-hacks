import { describe, expect, it, vi } from 'vitest';
import type { AmeliaEvent } from '../../shared/contracts';
import { AmeliaBus, REPLAY_BUFFER_SIZE } from './bus';

const utterance = (text: string): AmeliaEvent => ({
  type: 'utterance',
  utterance_id: `u-${text}`,
  conversation_id: 'c-1',
  text,
  start_ms: 0,
  end_ms: 100,
  is_final: true,
});

async function read(stream: ReadableStream<Uint8Array>, chunks: number): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (let i = 0; i < chunks; i += 1) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder.decode(value);
  }
  void reader.cancel();
  return out;
}

describe('AmeliaBus', () => {
  it('delivers to subscribers and stops on unsubscribe', () => {
    const bus = new AmeliaBus();
    const seen: AmeliaEvent[] = [];
    const unsubscribe = bus.subscribe((event) => seen.push(event));
    bus.emit(utterance('one'));
    unsubscribe();
    bus.emit(utterance('two'));
    expect(seen).toHaveLength(1);
  });

  it('isolates a throwing listener so later listeners still receive the event', () => {
    const bus = new AmeliaBus();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const downstream: string[] = [];

    bus.subscribe(() => {
      throw new Error('a closed SSE controller');
    });
    bus.subscribe((event) => downstream.push(event.type));

    expect(() => bus.emit(utterance('one'))).not.toThrow();
    expect(downstream).toEqual(['utterance']);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it('numbers events monotonically', () => {
    const bus = new AmeliaBus();
    expect(bus.emit(utterance('one')).id).toBe(1);
    expect(bus.emit(utterance('two')).id).toBe(2);
    expect(bus.lastEventId).toBe(2);
  });

  it('replays only what a reconnecting client missed', () => {
    const bus = new AmeliaBus();
    bus.emit(utterance('one'));
    const seen = bus.emit(utterance('two'));
    bus.emit(utterance('three'));

    const missed = bus.replaySince(seen.id);
    expect(missed.map((entry) => (entry.event as { text: string }).text)).toEqual(['three']);
  });

  it('streams replayed history to a client resuming from an event id', async () => {
    const bus = new AmeliaBus();
    bus.emit(utterance('before'));
    const resumeFrom = bus.emit(utterance('cutoff'));
    bus.emit(utterance('after'));

    const body = await read(bus.createEventStream(undefined, resumeFrom.id), 1);
    expect(body).toContain('u-after');
    expect(body).not.toContain('u-before');
    expect(body).toMatch(/^id: 3\n/);
  });

  it('flags a gap when the client resumes from history that has been dropped', async () => {
    const bus = new AmeliaBus();
    // Derived from the constant: hardcoding a count meant that raising the
    // buffer silently turned this into a test of nothing.
    for (let i = 0; i < REPLAY_BUFFER_SIZE + 50; i += 1) bus.emit(utterance(`e${i}`));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const body = await read(bus.createEventStream(undefined, 1), 1);
    expect(body).toContain(': gap');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does not throw when the client has already gone away', async () => {
    const bus = new AmeliaBus();
    const controller = new AbortController();
    const stream = bus.createEventStream(controller.signal);
    controller.abort();

    expect(() => bus.emit(utterance('after close'))).not.toThrow();
    await stream.cancel().catch(() => {});
  });

  it('keeps delivering to other listeners after one stream aborts', () => {
    const bus = new AmeliaBus();
    const controller = new AbortController();
    void bus.createEventStream(controller.signal);
    const seen: string[] = [];
    bus.subscribe((event) => seen.push(event.type));

    controller.abort();
    bus.emit(utterance('still flowing'));
    expect(seen).toEqual(['utterance']);
  });
});
