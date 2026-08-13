/**
 * Glasses → Lane A uplink.
 *
 * Lane E does not build its own AudioSession. It connects to Lane A's /stream
 * WebSocket as an ordinary client and speaks the framing frozen in contracts:
 * one JSON hello frame carrying conversation_id, then binary frames of exactly
 * AUDIO_FRAME_BYTES float32 samples at 16 kHz mono.
 *
 * That makes the glasses a second capture device on the identical path as the
 * phone — same StreamBuffer, same diarisation, same identity — with no new
 * ingest surface and nothing imported from Lane A's tree.
 */

import WebSocket from 'ws';
import {
  AUDIO_FRAME_BYTES,
  AUDIO_FRAME_SAMPLES,
  type Id,
  type StreamHandshake,
} from '../../shared/contracts';

const SAMPLE_RATE = 16_000;

/** Linear resample. Local to Lane E so nothing reaches into Lane A's tree. */
export function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || input.length === 0) return input;
  const ratio = fromRate / toRate;
  const output = new Float32Array(Math.max(1, Math.floor(input.length / ratio)));
  for (let i = 0; i < output.length; i++) {
    const source = i * ratio;
    const low = Math.floor(source);
    const high = Math.min(low + 1, input.length - 1);
    const t = source - low;
    output[i] = input[low]! * (1 - t) + input[high]! * t;
  }
  return output;
}

/**
 * Split a carry-over buffer plus a new chunk into whole contract frames.
 *
 * Pure so the framing can be tested without a socket. Returns the frames to
 * send and whatever remains — short frames must never go on the wire, because
 * StreamBuffer derives every timestamp from a monotonic sample cursor and a
 * partial frame would shift all of them.
 */
export function frameChunks(
  carry: Float32Array,
  chunk: Float32Array,
): { frames: Float32Array[]; rest: Float32Array } {
  const merged = new Float32Array(carry.length + chunk.length);
  merged.set(carry, 0);
  merged.set(chunk, carry.length);

  const frames: Float32Array[] = [];
  let offset = 0;
  while (merged.length - offset >= AUDIO_FRAME_SAMPLES) {
    // Copy, don't subarray: a view shares the buffer we are about to drop, and
    // ws may serialize the frame after this tick.
    frames.push(merged.slice(offset, offset + AUDIO_FRAME_SAMPLES));
    offset += AUDIO_FRAME_SAMPLES;
  }
  return { frames, rest: merged.slice(offset) };
}

export interface UplinkOptions {
  conversationId: Id;
  /** Defaults to the local server; override for ngrok or a remote host. */
  url?: string;
  onError?: (error: Error) => void;
}

/**
 * Buffers arbitrary-length chunks into exact contract frames.
 *
 * Audio chunks arrive many times per second at sizes the glasses choose, but
 * the wire format is fixed at 1,600 samples. Sending short frames would desync
 * every downstream timestamp, so partial audio is held until a frame is full.
 */
export class GlassesUplink {
  private socket: WebSocket | null = null;
  private pending: Float32Array = new Float32Array(0);
  private opened = false;
  private closed = false;
  private queue: Float32Array[] = [];

  constructor(private readonly options: UplinkOptions) {}

  get connected(): boolean {
    return this.opened && !this.closed;
  }

  connect(): void {
    const url = this.options.url ?? process.env.AMELIA_STREAM_URL ?? 'ws://localhost:3000/stream';
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.on('open', () => {
      const hello: StreamHandshake = { conversation_id: this.options.conversationId };
      socket.send(JSON.stringify(hello));
      this.opened = true;
      // Anything captured while connecting is flushed in order, so the first
      // seconds of a conversation are not silently dropped.
      for (const frame of this.queue) this.sendFrame(frame);
      this.queue = [];
    });

    socket.on('error', (error: Error) => this.options.onError?.(error));
    socket.on('close', () => {
      this.opened = false;
      this.closed = true;
    });
  }

  /** Feed one chunk of float32 PCM. Resamples to 16 kHz if needed. */
  push(samples: Float32Array, sampleRate = SAMPLE_RATE): void {
    if (this.closed) return;
    const pcm = resample(samples, sampleRate, SAMPLE_RATE);
    const { frames, rest } = frameChunks(this.pending, pcm);
    for (const frame of frames) {
      if (this.opened) this.sendFrame(frame);
      else this.queue.push(frame);
    }
    this.pending = rest;
  }

  private sendFrame(frame: Float32Array): void {
    const bytes = Buffer.from(frame.buffer, frame.byteOffset, AUDIO_FRAME_BYTES);
    this.socket?.send(bytes);
  }

  close(): void {
    this.closed = true;
    this.pending = new Float32Array(0);
    this.queue = [];
    try {
      this.socket?.close();
    } catch {
      /* already gone */
    }
  }
}
