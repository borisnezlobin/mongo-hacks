/**
 * The socket to the board, and nothing else.
 *
 * Every platform dependency is injected the way CaptureEngine's are, so the
 * reconnect behaviour can be driven from a test with a hand-cranked clock
 * rather than a real WebSocket and a real board that has to be plugged in.
 *
 * Audio leaves through a sink rather than an event, because the session swaps
 * where audio goes — pre-roll ring while idle, the /stream uplink once a
 * conversation starts — and routing 10 frames a second through the event
 * queue that also carries status would put the two on the same budget.
 */

import {
  GLASSES_DEFAULT_HOST,
  GLASSES_FRAME_JPEG,
  GLASSES_WS_PATH,
  GLASSES_WS_PORT,
  type GlassesAudioFrame,
  type GlassesControl,
  type GlassesHello,
  type GlassesJpegFrame,
  type GlassesStatus,
} from '../../shared/contracts';
import { reconnectDelayMs, CONNECT_TIMEOUT_MS } from '../src/state/recording';
import { encodeControl, parseGlassesFrame, parseGlassesMessage } from './protocol';

export type GlassesLinkStatus = 'disconnected' | 'connecting' | 'connected';

export type GlassesLinkEvent =
  | { type: 'link'; status: GlassesLinkStatus; reason?: string }
  | { type: 'hello'; hello: GlassesHello }
  | { type: 'status'; status: GlassesStatus }
  | { type: 'frame'; frame: GlassesJpegFrame };

export interface GlassesSocket {
  send(text: string): void;
  close(): void;
}

export interface GlassesSocketHandlers {
  onOpen(): void;
  onBinary(data: ArrayBuffer | ArrayBufferView): void;
  onText(text: string): void;
  /** Any terminal condition: refused, errored, or closed. */
  onClose(reason: string): void;
}

export interface GlassesLinkDeps {
  openSocket(url: string, handlers: GlassesSocketHandlers): GlassesSocket;
  emit(event: GlassesLinkEvent): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export type AudioSink = (frame: GlassesAudioFrame) => void;

export function glassesUrl(host: string = GLASSES_DEFAULT_HOST): string {
  return `ws://${host}:${GLASSES_WS_PORT}${GLASSES_WS_PATH}`;
}

export class GlassesLink {
  private socket: GlassesSocket | null = null;
  private status: GlassesLinkStatus = 'disconnected';
  private attempt = 0;
  private connectTimer: unknown = null;
  private retryTimer: unknown = null;
  private wanted = false;
  private host = GLASSES_DEFAULT_HOST;
  private readonly sinks = new Set<AudioSink>();

  constructor(private readonly deps: GlassesLinkDeps) {}

  get linkStatus(): GlassesLinkStatus {
    return this.status;
  }

  get connected(): boolean {
    return this.status === 'connected';
  }

  connect(host: string = GLASSES_DEFAULT_HOST): void {
    this.teardown();
    this.host = host;
    this.wanted = true;
    this.attempt = 0;
    this.open();
  }

  disconnect(): void {
    this.wanted = false;
    this.teardown();
    this.setStatus('disconnected');
  }

  /**
   * Audio goes to whoever is listening right now. A set rather than a single
   * sink so the session can attach the uplink before detaching the pre-roll
   * and never drop the frames in between.
   */
  subscribeAudio(sink: AudioSink): () => void {
    this.sinks.add(sink);
    return () => {
      this.sinks.delete(sink);
    };
  }

  send(control: GlassesControl): void {
    if (!this.socket || this.status !== 'connected') return;
    try {
      this.socket.send(encodeControl(control));
    } catch {
      // The close handler is about to schedule a reconnect; nothing to add.
    }
  }

  requestBurst(durationMs: number): void {
    this.send({ type: 'burst', duration_ms: durationMs });
  }

  private open(): void {
    this.setStatus('connecting');
    let settled = false;
    const socket = this.deps.openSocket(glassesUrl(this.host), {
      onOpen: () => {
        if (settled || this.socket !== socket) return;
        settled = true;
        this.clearConnectTimer();
        this.attempt = 0;
        this.setStatus('connected');
      },
      onBinary: (data) => {
        if (this.socket === socket) this.routeBinary(data);
      },
      onText: (text) => {
        if (this.socket === socket) this.routeText(text);
      },
      onClose: (reason) => {
        if (this.socket !== socket) return;
        settled = true;
        this.clearConnectTimer();
        this.socket = null;
        this.lose(reason);
      },
    });
    this.socket = socket;

    this.connectTimer = this.deps.setTimer(() => {
      this.connectTimer = null;
      if (settled || this.socket !== socket) return;
      settled = true;
      this.socket = null;
      closeQuietly(socket);
      this.lose('the board did not answer');
    }, CONNECT_TIMEOUT_MS);
  }

  private routeBinary(data: ArrayBuffer | ArrayBufferView): void {
    const frame = parseGlassesFrame(data);
    if (!frame) return;
    if (frame.kind === GLASSES_FRAME_JPEG) {
      this.deps.emit({ type: 'frame', frame });
      return;
    }
    for (const sink of this.sinks) sink(frame);
  }

  private routeText(text: string): void {
    const message = parseGlassesMessage(text);
    if (!message) return;
    if (message.type === 'hello') this.deps.emit({ type: 'hello', hello: message });
    else this.deps.emit({ type: 'status', status: message });
  }

  /**
   * The board is USB-powered and the phone walks in and out of its softAP, so
   * a lost link is the ordinary case and retrying forever is the correct
   * behaviour. The delay is capped rather than the attempts.
   */
  private lose(reason: string): void {
    if (!this.wanted) return;
    this.attempt += 1;
    this.setStatus('disconnected', reason);
    this.retryTimer = this.deps.setTimer(() => {
      this.retryTimer = null;
      if (!this.wanted) return;
      this.open();
    }, reconnectDelayMs(this.attempt));
  }

  private setStatus(status: GlassesLinkStatus, reason?: string): void {
    if (this.status === status && reason === undefined) return;
    this.status = status;
    this.deps.emit({ type: 'link', status, reason });
  }

  private clearConnectTimer(): void {
    if (this.connectTimer === null) return;
    this.deps.clearTimer(this.connectTimer);
    this.connectTimer = null;
  }

  private teardown(): void {
    this.clearConnectTimer();
    if (this.retryTimer !== null) {
      this.deps.clearTimer(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      closeQuietly(socket);
    }
    this.attempt = 0;
  }
}

function closeQuietly(socket: GlassesSocket): void {
  try {
    socket.close();
  } catch {
    // Already gone.
  }
}
