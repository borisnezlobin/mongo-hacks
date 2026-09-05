/**
 * Read a glasses capture directory back into memory.
 *
 * The format is whatever `tools/glasses-smoke.mts` writes off the board —
 * audio.wav, frames/NNNNNN.jpg, frames.jsonl, status.jsonl — and both replay
 * tools consume it, so the reader lives beside the fixtures rather than inside
 * one of the two tools that happen to need it first.
 *
 * Nothing here is glasses-specific beyond the file names: it is a directory of
 * timestamped audio and timestamped images, which is all a capture is.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { GlassesStatus } from '../../shared/contracts';

export interface FixtureFrame {
  file: string;
  seq: number;
  ts_ms: number;
  width: number;
  height: number;
  jpeg: Uint8Array;
}

export interface GlassesFixture {
  dir: string;
  sampleRate: number;
  samples: Int16Array;
  frames: FixtureFrame[];
  statuses: GlassesStatus[];
  durationMs: number;
}

interface FrameLine {
  file: string;
  seq: number;
  ts_ms: number;
  width?: number;
  height?: number;
}

function readJsonl<T>(path: string): T[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

/**
 * int16 rather than float32, because that is what the board sends and what the
 * protocol encoders take. The conversion belongs at the phone, once.
 */
function readInt16Wav(path: string): { sampleRate: number; samples: Int16Array } {
  const bytes = readFileSync(path);
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${path} is not a RIFF/WAVE file`);
  }
  let offset = 12;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let channels = 0;
  let data: Buffer | null = null;
  while (offset + 8 <= bytes.length) {
    const chunkId = bytes.toString('ascii', offset, offset + 4);
    const chunkSize = bytes.readUInt32LE(offset + 4);
    if (chunkId === 'fmt ') {
      channels = bytes.readUInt16LE(offset + 10);
      sampleRate = bytes.readUInt32LE(offset + 12);
      bitsPerSample = bytes.readUInt16LE(offset + 22);
    } else if (chunkId === 'data') {
      data = bytes.subarray(offset + 8, offset + 8 + chunkSize);
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  if (!data) throw new Error(`${path} has no data chunk`);
  if (channels !== 1 || bitsPerSample !== 16) {
    throw new Error(`${path} is ${bitsPerSample}-bit ${channels}ch; expected 16-bit mono`);
  }
  const samples = new Int16Array(data.length / 2);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = data.readInt16LE(index * 2);
  }
  return { sampleRate, samples };
}

export function readGlassesFixture(dir: string): GlassesFixture {
  const { sampleRate, samples } = readInt16Wav(join(dir, 'audio.wav'));
  const frames = readJsonl<FrameLine>(join(dir, 'frames.jsonl')).map((line) => ({
    file: line.file,
    seq: line.seq,
    ts_ms: line.ts_ms,
    width: line.width ?? 0,
    height: line.height ?? 0,
    jpeg: new Uint8Array(readFileSync(join(dir, line.file))),
  }));
  const statuses = readJsonl<GlassesStatus>(join(dir, 'status.jsonl'));
  const audioMs = (samples.length / sampleRate) * 1_000;
  const lastFrameMs = frames.length === 0 ? 0 : (frames[frames.length - 1] as FixtureFrame).ts_ms;
  return {
    dir,
    sampleRate,
    samples,
    frames,
    statuses,
    durationMs: Math.max(audioMs, lastFrameMs),
  };
}

/** Loudness in dBFS over one window, the same quantity the board's VAD gates on. */
export function windowEnergyDb(samples: Int16Array, start: number, count: number): number {
  const end = Math.min(samples.length, start + count);
  if (end <= start) return -120;
  let sum = 0;
  for (let index = start; index < end; index += 1) {
    const value = (samples[index] as number) / 32_768;
    sum += value * value;
  }
  const rms = Math.sqrt(sum / (end - start));
  return rms === 0 ? -120 : 20 * Math.log10(rms);
}

export const VAD_WINDOW_MS = 300;
/** How far above the quietest part of the capture counts as speech. */
export const VAD_MARGIN_DB = 12;

/**
 * A noise floor for the whole capture, taken once.
 *
 * The board tracks its floor with a running average because it has to decide
 * live. A fixture is finished, so the honest floor is the quiet tenth of it —
 * cheaper, and it cannot be dragged upward by the speech it is meant to find.
 */
export function noiseFloorDb(samples: Int16Array, sampleRate: number): number {
  const window = Math.round((sampleRate * VAD_WINDOW_MS) / 1_000);
  const levels: number[] = [];
  for (let start = 0; start + window <= samples.length; start += window) {
    levels.push(windowEnergyDb(samples, start, window));
  }
  if (levels.length === 0) return -120;
  levels.sort((a, b) => a - b);
  return levels[Math.floor(levels.length * 0.1)] as number;
}

export interface EnergyGate {
  speechAt(tsMs: number): boolean;
}

/** The simplest thing that reproduces the board's VAD line in a status message. */
export function energyGate(samples: Int16Array, sampleRate: number): EnergyGate {
  const window = Math.round((sampleRate * VAD_WINDOW_MS) / 1_000);
  const floor = noiseFloorDb(samples, sampleRate);
  return {
    speechAt(tsMs: number): boolean {
      const start = Math.max(0, Math.round((tsMs * sampleRate) / 1_000) - window);
      return windowEnergyDb(samples, start, window) > floor + VAD_MARGIN_DB;
    },
  };
}
