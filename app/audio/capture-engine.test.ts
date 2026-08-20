import { describe, expect, it } from 'vitest';
import { AUDIO_FRAME_SAMPLES } from '../../shared/contracts';
import {
  CONNECT_TIMEOUT_MS,
  RECONNECT_MAX_ATTEMPTS,
  initialRecordingState,
  recordingReducer,
  reconnectDelayMs,
  type RecordingEvent,
  type RecordingState,
} from '../src/state/recording';
import { CaptureEngine, MAX_BUFFERED_FRAMES, type CaptureSocket, type SocketHandlers } from './capture-engine';

/** A clock the test drives by hand, so backoff can be asserted rather than waited out. */
function createClock() {
  let now = 0;
  let nextId = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimer(fn: () => void, ms: number) {
      const id = nextId++;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer(handle: unknown) {
      pending.delete(handle as number);
    },
    advance(ms: number) {
      const target = now + ms;
      let guard = 0;
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort(([, a], [, b]) => a.at - b.at)[0];
        if (!due || (guard += 1) > 100) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = target;
    },
    get pendingCount() {
      return pending.size;
    },
  };
}

interface Harness {
  engine: CaptureEngine;
  clock: ReturnType<typeof createClock>;
  sockets: FakeSocket[];
  events: RecordingEvent[];
  state(): RecordingState;
  micHeld(): boolean;
}

class FakeSocket implements CaptureSocket {
  sent: ArrayBuffer[] = [];
  closed = false;
  failSend = false;
  constructor(readonly conversationId: string, readonly handlers: SocketHandlers) {}
  send(frame: ArrayBuffer) {
    if (this.failSend) throw new Error('send failed');
    this.sent.push(frame);
  }
  close() {
    this.closed = true;
  }
}

function harness(options: { acquireError?: Error } = {}): Harness {
  const clock = createClock();
  const sockets: FakeSocket[] = [];
  const events: RecordingEvent[] = [];
  let held = false;
  let samples: ((samples: Float32Array) => void) | null = null;

  const engine = new CaptureEngine({
    openSocket(conversationId, handlers) {
      const socket = new FakeSocket(conversationId, handlers);
      sockets.push(socket);
      return socket;
    },
    async acquireMicrophone(onSamples) {
      if (options.acquireError) throw options.acquireError;
      held = true;
      samples = onSamples;
    },
    releaseMicrophone() {
      held = false;
      samples = null;
    },
    emit: (event) => events.push(event),
    setTimer: (fn, ms) => clock.setTimer(fn, ms),
    clearTimer: (handle) => clock.clearTimer(handle),
  });

  void samples;
  return {
    engine,
    clock,
    sockets,
    events,
    state: () => events.reduce(recordingReducer, initialRecordingState),
    micHeld: () => held,
  };
}

const frame = () => new Float32Array(AUDIO_FRAME_SAMPLES);

describe('capture engine', () => {
  it('reaches streaming once the socket opens', async () => {
    const h = harness();
    await h.engine.start('c-1');
    expect(h.sockets).toHaveLength(1);
    expect(h.sockets[0].conversationId).toBe('c-1');

    h.sockets[0].handlers.onOpen();
    expect(h.state().status).toBe('streaming');
    expect(h.micHeld()).toBe(true);
  });

  it('reports a denied permission without opening a socket', async () => {
    const h = harness({ acquireError: new Error('Microphone permission was not granted') });
    await h.engine.start('c-1');
    expect(h.sockets).toHaveLength(0);
    expect(h.state().status).toBe('error');
    expect(h.state().error?.code).toBe('permission-denied');
  });

  it('reports a busy microphone as its own reason', async () => {
    const h = harness({ acquireError: new Error('Voice setup is using the microphone. Finish it first.') });
    await h.engine.start('c-1');
    expect(h.state().error?.code).toBe('mic-busy');
  });

  /** "Connecting" used to be able to hang forever behind a disabled button. */
  it('gives up on a socket that never opens', async () => {
    const h = harness();
    await h.engine.start('c-1');
    expect(h.state().status).toBe('connecting');

    h.clock.advance(CONNECT_TIMEOUT_MS);
    expect(h.sockets[0].closed).toBe(true);
    expect(h.state().status).toBe('reconnecting');
  });

  it('reconnects on a drop with exponential backoff', async () => {
    const h = harness();
    await h.engine.start('c-1');
    h.sockets[0].handlers.onOpen();

    h.sockets[0].handlers.onClose('the socket closed');
    expect(h.state().status).toBe('reconnecting');
    expect(h.state().attempt).toBe(1);

    // Nothing before the delay elapses.
    h.clock.advance(reconnectDelayMs(1) - 1);
    expect(h.sockets).toHaveLength(1);

    h.clock.advance(1);
    expect(h.sockets).toHaveLength(2);
    h.sockets[1].handlers.onOpen();
    expect(h.state().status).toBe('streaming');
    expect(h.state().attempt).toBe(0);
  });

  /** A dropped socket used to end the recording and discard whatever had not been sent. */
  it('holds buffered frames through a drop and sends them on reconnect', async () => {
    const h = harness();
    await h.engine.start('c-1');
    h.sockets[0].handlers.onOpen();

    h.engine.pushSamples(frame());
    expect(h.sockets[0].sent).toHaveLength(1);

    h.sockets[0].handlers.onClose('dropped');
    h.engine.pushSamples(frame());
    h.engine.pushSamples(frame());
    expect(h.engine.bufferedFrames).toBe(2);

    h.clock.advance(reconnectDelayMs(1));
    h.sockets[1].handlers.onOpen();
    expect(h.sockets[1].sent).toHaveLength(2);
    expect(h.engine.bufferedFrames).toBe(0);
  });

  it('caps the buffer so a server that never comes back cannot eat memory', async () => {
    const h = harness();
    await h.engine.start('c-1');
    h.sockets[0].handlers.onOpen();
    h.sockets[0].handlers.onClose('dropped');

    for (let index = 0; index < MAX_BUFFERED_FRAMES + 50; index += 1) h.engine.pushSamples(frame());
    expect(h.engine.bufferedFrames).toBe(MAX_BUFFERED_FRAMES);
  });

  it('keeps a frame the socket refused rather than dropping it', async () => {
    const h = harness();
    await h.engine.start('c-1');
    h.sockets[0].handlers.onOpen();
    h.sockets[0].failSend = true;

    h.engine.pushSamples(frame());
    expect(h.engine.bufferedFrames).toBe(1);
  });

  it('stops retrying and says so after the attempt ceiling', async () => {
    const h = harness();
    await h.engine.start('c-1');

    for (let attempt = 1; attempt <= RECONNECT_MAX_ATTEMPTS; attempt += 1) {
      h.clock.advance(CONNECT_TIMEOUT_MS);
      h.clock.advance(reconnectDelayMs(attempt));
    }
    h.clock.advance(CONNECT_TIMEOUT_MS);

    expect(h.state().status).toBe('error');
    expect(h.state().error?.code).toBe('connect-timeout');
    expect(h.micHeld()).toBe(false);
  });

  it('releases the microphone and cancels every timer on stop', async () => {
    const h = harness();
    await h.engine.start('c-1');
    h.sockets[0].handlers.onOpen();
    h.sockets[0].handlers.onClose('dropped');
    expect(h.clock.pendingCount).toBeGreaterThan(0);

    h.engine.stop();
    expect(h.micHeld()).toBe(false);
    expect(h.clock.pendingCount).toBe(0);
    expect(h.state().status).toBe('stopping');
  });

  /** Backgrounding on a platform that cannot keep recording must say so, not die quietly. */
  it('surfaces an interruption as an error with its reason', async () => {
    const h = harness();
    await h.engine.start('c-1');
    h.sockets[0].handlers.onOpen();

    h.engine.interrupt('backgrounded', 'Recording stopped when Amelia went to the background.');
    expect(h.state().status).toBe('error');
    expect(h.state().error).toEqual({
      code: 'backgrounded',
      message: 'Recording stopped when Amelia went to the background.',
    });
    expect(h.micHeld()).toBe(false);
  });

  it('starting again abandons the previous session cleanly', async () => {
    const h = harness();
    await h.engine.start('c-1');
    h.sockets[0].handlers.onOpen();

    await h.engine.start('c-2');
    expect(h.sockets[0].closed).toBe(true);
    expect(h.sockets[1].conversationId).toBe('c-2');
    h.sockets[1].handlers.onOpen();
    expect(h.state().conversationId).toBe('c-2');
  });
});
