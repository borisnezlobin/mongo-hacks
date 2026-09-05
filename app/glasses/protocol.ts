/**
 * The glasses wire format, in one file both the phone and the smoke tool read.
 *
 * The board and the app are two codebases in two languages that have to agree
 * byte for byte, so the shape lives in shared/contracts.ts and the codec lives
 * here. Nothing in this file imports React Native or expo: the Mac-side smoke
 * tool parses real captures with exactly the functions the phone runs.
 */

import {
  GLASSES_FRAME_AUDIO,
  GLASSES_FRAME_JPEG,
  GLASSES_HEADER_BYTES,
  GLASSES_JPEG_HEADER_BYTES,
  type GlassesAudioFrame,
  type GlassesControl,
  type GlassesFrame,
  type GlassesMessage,
} from '../../shared/contracts';
import { int16ToFloat32 } from '../audio/resample';

function viewOf(data: ArrayBuffer | ArrayBufferView): DataView {
  return ArrayBuffer.isView(data)
    ? new DataView(data.buffer, data.byteOffset, data.byteLength)
    : new DataView(data);
}

function bytesOf(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  return ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data);
}

/**
 * int16 samples, copied out rather than viewed.
 *
 * A DataView read per sample rather than an Int16Array view because the header
 * is 8 bytes but the frame may sit at any offset inside a socket's buffer, and
 * an Int16Array cannot be created on an odd byte offset at all.
 */
function readSamples(view: DataView, offset: number): Int16Array {
  const count = Math.floor((view.byteLength - offset) / 2);
  const samples = new Int16Array(count);
  for (let index = 0; index < count; index += 1) {
    samples[index] = view.getInt16(offset + index * 2, true);
  }
  return samples;
}

function parseAudio(view: DataView, seq: number, tsMs: number): GlassesAudioFrame {
  return {
    kind: GLASSES_FRAME_AUDIO,
    seq,
    ts_ms: tsMs,
    samples: readSamples(view, GLASSES_HEADER_BYTES),
  };
}

function parseJpeg(
  data: ArrayBuffer | ArrayBufferView,
  view: DataView,
  seq: number,
  tsMs: number,
): GlassesFrame | null {
  if (view.byteLength < GLASSES_JPEG_HEADER_BYTES) return null;
  return {
    kind: GLASSES_FRAME_JPEG,
    seq,
    ts_ms: tsMs,
    width: view.getUint16(GLASSES_HEADER_BYTES, true),
    height: view.getUint16(GLASSES_HEADER_BYTES + 2, true),
    jpeg: bytesOf(data).slice(GLASSES_JPEG_HEADER_BYTES),
  };
}

/**
 * A binary frame off the socket. Returns null for anything malformed rather
 * than throwing: a truncated frame on a lossy link is an ordinary event, and
 * the link's job is to count it and carry on.
 */
export function parseGlassesFrame(data: ArrayBuffer | ArrayBufferView): GlassesFrame | null {
  const view = viewOf(data);
  if (view.byteLength < GLASSES_HEADER_BYTES) return null;
  const kind = view.getUint8(0);
  const seq = view.getUint16(2, true);
  const tsMs = view.getUint32(4, true);
  if (kind === GLASSES_FRAME_AUDIO) return parseAudio(view, seq, tsMs);
  if (kind === GLASSES_FRAME_JPEG) return parseJpeg(data, view, seq, tsMs);
  return null;
}

const MESSAGE_TYPES = new Set(['hello', 'status']);

/** A JSON text frame: hello or status. Unknown types are ignored, not thrown. */
export function parseGlassesMessage(text: string): GlassesMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const type = (parsed as { type?: unknown }).type;
  if (typeof type !== 'string' || !MESSAGE_TYPES.has(type)) return null;
  return parsed as GlassesMessage;
}

export function encodeControl(control: GlassesControl): string {
  return JSON.stringify(control);
}

/** The one conversion between the link and the /stream contract. */
export function audioFrameToFloat32(frame: GlassesAudioFrame): Float32Array {
  return int16ToFloat32(frame.samples);
}

/** Builds a frame, so the fake board and the tests speak the same bytes. */
export function encodeAudioFrame(seq: number, tsMs: number, samples: Int16Array): ArrayBuffer {
  const buffer = new ArrayBuffer(GLASSES_HEADER_BYTES + samples.length * 2);
  const view = new DataView(buffer);
  writeHeader(view, GLASSES_FRAME_AUDIO, seq, tsMs);
  for (let index = 0; index < samples.length; index += 1) {
    view.setInt16(GLASSES_HEADER_BYTES + index * 2, samples[index], true);
  }
  return buffer;
}

export function encodeJpegFrame(
  seq: number,
  tsMs: number,
  width: number,
  height: number,
  jpeg: Uint8Array,
): ArrayBuffer {
  const buffer = new ArrayBuffer(GLASSES_JPEG_HEADER_BYTES + jpeg.length);
  const view = new DataView(buffer);
  writeHeader(view, GLASSES_FRAME_JPEG, seq, tsMs);
  view.setUint16(GLASSES_HEADER_BYTES, width, true);
  view.setUint16(GLASSES_HEADER_BYTES + 2, height, true);
  new Uint8Array(buffer).set(jpeg, GLASSES_JPEG_HEADER_BYTES);
  return buffer;
}

function writeHeader(view: DataView, kind: number, seq: number, tsMs: number): void {
  view.setUint8(0, kind);
  view.setUint8(1, 0);
  view.setUint16(2, seq & 0xffff, true);
  view.setUint32(4, tsMs >>> 0, true);
}
