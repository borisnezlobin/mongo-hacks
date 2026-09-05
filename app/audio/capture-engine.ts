import type { CaptureMode, Id } from '../../shared/contracts';
import {
  CONNECT_TIMEOUT_MS,
  RECONNECT_MAX_ATTEMPTS,
  reconnectDelayMs,
  type RecordingErrorCode,
  type RecordingEvent,
} from '../src/state/recording';
import { AudioFramePacketizer } from './uplink-buffer';

/**
 * The uplink's behaviour, with every platform dependency injected so it can be driven
 * from a test: connect timeout, exponential-backoff reconnect, and a frame buffer that
 * survives the gap. Previously a dropped socket simply ended the recording and threw
 * away whatever PCM had not been sent, silently.
 */

export interface CaptureSocket {
  send(frame: ArrayBuffer): void;
  close(): void;
}

export interface SocketHandlers {
  onOpen(): void;
  /** Any terminal socket condition: refused, errored, or closed. */
  onClose(reason: string): void;
}

/**
 * Anything beyond the conversation id that belongs on the /stream handshake.
 *
 * Optional throughout: the phone with no glasses sends none of it, and the
 * server reads a missing capture_mode as 'group' and keeps everything, which
 * is exactly today's behaviour.
 */
export interface HandshakeExtras {
  capture_mode?: CaptureMode;
}

export interface CaptureEngineDeps {
  openSocket(conversationId: Id, handlers: SocketHandlers, extras?: HandshakeExtras): CaptureSocket;
  acquireMicrophone(onSamples: (samples: Float32Array) => void): Promise<void>;
  releaseMicrophone(): void;
  emit(event: RecordingEvent): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

/**
 * About twenty seconds of 100 ms frames. Enough to ride out a lift or a wifi handover
 * without letting a server that is gone for an hour eat the phone's memory.
 */
export const MAX_BUFFERED_FRAMES = 200;

type Phase = 'idle' | 'connecting' | 'streaming' | 'waiting' | 'stopped';

export class CaptureEngine {
  private phase: Phase = 'idle';
  private conversationId: Id | null = null;
  private socket: CaptureSocket | null = null;
  private packetizer = new AudioFramePacketizer();
  private buffered: ArrayBuffer[] = [];
  private attempt = 0;
  private connectTimer: unknown = null;
  private retryTimer: unknown = null;
  private micHeld = false;
  private handshakeExtras: HandshakeExtras | undefined;

  constructor(private readonly deps: CaptureEngineDeps) {}

  get bufferedFrames(): number {
    return this.buffered.length;
  }

  async start(conversationId: Id, handshakeExtras?: HandshakeExtras): Promise<void> {
    this.teardown();
    this.phase = 'connecting';
    this.conversationId = conversationId;
    // Kept for the life of the session so a reconnect re-declares it; the
    // server sees a fresh handshake and would otherwise fall back to 'group'.
    this.handshakeExtras = handshakeExtras;
    this.attempt = 0;
    this.deps.emit({ type: 'start', conversationId });

    try {
      await this.deps.acquireMicrophone((samples) => this.pushSamples(samples));
      this.micHeld = true;
    } catch (error) {
      this.phase = 'idle';
      const message = error instanceof Error ? error.message : String(error);
      const code: RecordingErrorCode = /permission/i.test(message)
        ? 'permission-denied'
        : /microphone|busy/i.test(message) ? 'mic-busy' : 'capture-failed';
      if (code === 'permission-denied') this.deps.emit({ type: 'permission-denied' });
      else this.deps.emit({ type: 'failed', error: { code, message } });
      return;
    }

    this.deps.emit({ type: 'permission-granted' });
    this.connect();
  }

  /** A clean stop: no reconnect, no error, buffered audio dropped with the session. */
  stop(): void {
    if (this.phase === 'idle') return;
    this.teardown();
    this.phase = 'idle';
    this.deps.emit({ type: 'stop' });
    this.deps.emit({ type: 'stopped' });
  }

  /** The OS took the microphone away. Stops cleanly and says why. */
  interrupt(code: RecordingErrorCode, message: string): void {
    if (this.phase === 'idle') return;
    this.teardown();
    this.phase = 'idle';
    this.deps.emit({ type: 'failed', error: { code, message } });
  }

  pushSamples(samples: Float32Array): void {
    if (this.phase === 'idle') return;
    for (const frame of this.packetizer.push(samples)) this.enqueue(frame);
    this.flush();
  }

  private enqueue(frame: ArrayBuffer): void {
    this.buffered.push(frame);
    if (this.buffered.length > MAX_BUFFERED_FRAMES) {
      // Drop the oldest: recent speech is what the transcript is waiting on.
      this.buffered.splice(0, this.buffered.length - MAX_BUFFERED_FRAMES);
    }
    this.deps.emit({ type: 'buffered', frames: this.buffered.length });
  }

  private flush(): void {
    if (this.phase !== 'streaming' || !this.socket) return;
    while (this.buffered.length > 0) {
      const frame = this.buffered[0];
      try {
        this.socket.send(frame);
      } catch {
        // Keep the frame; the close handler will schedule a reconnect that resends it.
        return;
      }
      this.buffered.shift();
    }
    this.deps.emit({ type: 'buffered', frames: 0 });
  }

  private connect(): void {
    const conversationId = this.conversationId;
    if (!conversationId) return;
    this.phase = 'connecting';

    let settled = false;
    const socket = this.deps.openSocket(conversationId, {
      onOpen: () => {
        if (settled || this.socket !== socket) return;
        settled = true;
        this.clearConnectTimer();
        this.phase = 'streaming';
        this.attempt = 0;
        this.deps.emit({ type: 'connected' });
        this.deps.emit({ type: 'capturing' });
        this.flush();
      },
      onClose: (reason) => {
        if (this.socket !== socket) return;
        settled = true;
        this.clearConnectTimer();
        this.socket = null;
        this.lose('connection-lost', reason);
      },
    }, this.handshakeExtras);
    this.socket = socket;

    // Without this the button sat disabled on "Connecting" for as long as the socket
    // took to never answer, which on a bad network is forever.
    this.connectTimer = this.deps.setTimer(() => {
      this.connectTimer = null;
      if (settled || this.socket !== socket) return;
      settled = true;
      this.socket = null;
      try {
        socket.close();
      } catch {
        // Already gone.
      }
      this.lose('connect-timeout', 'The server did not answer in time.');
    }, CONNECT_TIMEOUT_MS);
  }

  private lose(code: RecordingErrorCode, message: string): void {
    if (this.phase === 'idle') return;
    this.attempt += 1;
    if (this.attempt > RECONNECT_MAX_ATTEMPTS) {
      this.teardown();
      this.phase = 'idle';
      this.deps.emit({
        type: 'failed',
        error: {
          code,
          message: code === 'connect-timeout'
            ? "Couldn't reach Amelia's server. Check that it is running."
            : `Lost the connection: ${message}`,
        },
      });
      return;
    }

    this.phase = 'waiting';
    this.deps.emit({ type: 'connection-lost', reason: code, message });
    this.retryTimer = this.deps.setTimer(() => {
      this.retryTimer = null;
      if (this.phase !== 'waiting') return;
      this.deps.emit({ type: 'retry' });
      this.connect();
    }, reconnectDelayMs(this.attempt));
  }

  private clearConnectTimer(): void {
    if (this.connectTimer !== null) {
      this.deps.clearTimer(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private teardown(): void {
    this.clearConnectTimer();
    if (this.retryTimer !== null) {
      this.deps.clearTimer(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // Already closed.
      }
      this.socket = null;
    }
    if (this.micHeld) {
      this.deps.releaseMicrophone();
      this.micHeld = false;
    }
    this.packetizer.reset();
    this.buffered = [];
    this.conversationId = null;
    this.handshakeExtras = undefined;
    this.attempt = 0;
  }
}
