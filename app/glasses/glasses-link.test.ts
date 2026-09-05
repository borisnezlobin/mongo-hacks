import { describe, expect, it } from 'vitest';
import { CONNECT_TIMEOUT_MS, reconnectDelayMs } from '../src/state/recording';
import {
  GlassesLink,
  glassesUrl,
  type GlassesLinkEvent,
  type GlassesSocket,
  type GlassesSocketHandlers,
} from './glasses-link';
import { encodeAudioFrame, encodeJpegFrame } from './protocol';
import { createTestClock } from './test-clock';

class FakeSocket implements GlassesSocket {
  sent: string[] = [];
  closed = false;
  constructor(readonly url: string, readonly handlers: GlassesSocketHandlers) {}
  send(text: string) {
    this.sent.push(text);
  }
  close() {
    this.closed = true;
  }
}

function harness() {
  const clock = createTestClock();
  const sockets: FakeSocket[] = [];
  const events: GlassesLinkEvent[] = [];
  const link = new GlassesLink({
    openSocket(url, handlers) {
      const socket = new FakeSocket(url, handlers);
      sockets.push(socket);
      return socket;
    },
    emit: (event) => events.push(event),
    setTimer: (fn, ms) => clock.setTimer(fn, ms),
    clearTimer: (handle) => clock.clearTimer(handle),
  });
  return { link, clock, sockets, events };
}

const status = (tsMs: number) => JSON.stringify({
  type: 'status', ts_ms: tsMs, die_c: 44, camera: 'idle', vad: false,
  fps: 0.2, audio_drops: 0, frame_drops: 0, heap_free: 100, psram_free: 200,
});

describe('glasses link', () => {
  it('opens the board address and reports connected', () => {
    const h = harness();
    h.link.connect('10.0.0.9');
    expect(h.sockets[0].url).toBe(glassesUrl('10.0.0.9'));
    h.sockets[0].handlers.onOpen();
    expect(h.link.connected).toBe(true);
    expect(h.events.map((event) => event.type)).toEqual(['link', 'link']);
  });

  it('routes audio to sinks and jpegs to events', () => {
    const h = harness();
    h.link.connect();
    h.sockets[0].handlers.onOpen();

    const heard: number[] = [];
    const unsubscribe = h.link.subscribeAudio((frame) => heard.push(frame.samples.length));
    h.sockets[0].handlers.onBinary(encodeAudioFrame(1, 100, new Int16Array(1_600)));
    h.sockets[0].handlers.onBinary(encodeJpegFrame(1, 120, 640, 480, new Uint8Array([1, 2, 3])));

    expect(heard).toEqual([1_600]);
    expect(h.events.filter((event) => event.type === 'frame')).toHaveLength(1);

    unsubscribe();
    h.sockets[0].handlers.onBinary(encodeAudioFrame(2, 200, new Int16Array(1_600)));
    expect(heard).toEqual([1_600]);
  });

  it('emits hello and status from text frames', () => {
    const h = harness();
    h.link.connect();
    h.sockets[0].handlers.onOpen();
    h.sockets[0].handlers.onText(JSON.stringify({
      type: 'hello', protocol: 1, firmware: 'a', sample_rate: 16_000, frame_samples: 1_600,
    }));
    h.sockets[0].handlers.onText(status(1_000));
    h.sockets[0].handlers.onText('garbage');
    expect(h.events.map((event) => event.type)).toEqual(['link', 'link', 'hello', 'status']);
  });

  it('reconnects with backoff and keeps trying past the recording ceiling', () => {
    const h = harness();
    h.link.connect();
    h.sockets[0].handlers.onOpen();
    h.sockets[0].handlers.onClose('dropped');
    expect(h.link.connected).toBe(false);

    h.clock.advance(reconnectDelayMs(1) - 1);
    expect(h.sockets).toHaveLength(1);
    h.clock.advance(1);
    expect(h.sockets).toHaveLength(2);

    // Ten failures later it is still trying: the board comes and goes by design.
    for (let attempt = 2; attempt <= 11; attempt += 1) {
      h.sockets[h.sockets.length - 1].handlers.onClose('dropped');
      h.clock.advance(reconnectDelayMs(attempt));
    }
    expect(h.sockets.length).toBe(12);
  });

  it('gives up on a socket that never opens and retries', () => {
    const h = harness();
    h.link.connect();
    h.clock.advance(CONNECT_TIMEOUT_MS);
    expect(h.sockets[0].closed).toBe(true);
    h.clock.advance(reconnectDelayMs(1));
    expect(h.sockets).toHaveLength(2);
  });

  it('sends a burst request only while connected', () => {
    const h = harness();
    h.link.connect();
    h.link.requestBurst(5_000);
    expect(h.sockets[0].sent).toEqual([]);
    h.sockets[0].handlers.onOpen();
    h.link.requestBurst(5_000);
    expect(h.sockets[0].sent).toEqual(['{"type":"burst","duration_ms":5000}']);
  });

  it('disconnecting stops the retry loop and closes the socket', () => {
    const h = harness();
    h.link.connect();
    h.sockets[0].handlers.onOpen();
    h.sockets[0].handlers.onClose('dropped');
    h.link.disconnect();
    h.clock.advance(60_000);
    expect(h.sockets).toHaveLength(1);
    expect(h.clock.pendingCount).toBe(0);
  });
});
