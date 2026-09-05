/**
 * Rebuild the committed synthetic glasses capture.
 *
 *   bun fixtures/glasses/synthetic/generate.mts
 *
 * The real fixture format is whatever `tools/glasses-smoke.mts` writes off the
 * board, and real captures are personal data, so they are gitignored. That
 * leaves the replay tools with nothing to run against in a fresh checkout —
 * hence this: three seconds of the same directory shape, entirely synthetic,
 * small enough to commit and deterministic so two machines produce the same
 * bytes.
 *
 * It is a shape test, not a perception test. The tone is not speech and the
 * drawn face is not a face; what it proves is that the wire format, the pacing,
 * the JSONL indexes and the replay path all hold together.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GLASSES_BURST_FPS,
  type GlassesStatus,
} from '../../../shared/contracts';
import { encodeGrayJpeg, type GrayImage } from './jpeg';

const SAMPLE_RATE = 16_000;
const DURATION_MS = 3_000;
const FRAME_WIDTH = 160;
const FRAME_HEIGHT = 120;
/** Three frames: one before the speech, one during, one after it stops. */
const FRAME_TIMES_MS = [200, 900, 2_600];
const JPEG_QUALITY = 72;

const here = dirname(fileURLToPath(import.meta.url));

/** Two syllable bursts with a gap, so an energy gate sees speech and quiet. */
function speechEnvelope(seconds: number): number {
  if (seconds < 0.4 || seconds > 2.2) return 0;
  const syllable = Math.abs(Math.sin(2 * Math.PI * 3.5 * seconds));
  const gap = seconds > 1.25 && seconds < 1.5 ? 0 : 1;
  return syllable * gap;
}

/** A 140 Hz fundamental with two harmonics: voice-shaped, not a pure tone. */
function glottalTone(seconds: number): number {
  const fundamental = Math.sin(2 * Math.PI * 140 * seconds);
  const second = 0.5 * Math.sin(2 * Math.PI * 280 * seconds);
  const third = 0.25 * Math.sin(2 * Math.PI * 420 * seconds);
  return (fundamental + second + third) / 1.75;
}

function renderAudio(): Int16Array {
  const total = (SAMPLE_RATE * DURATION_MS) / 1_000;
  const samples = new Int16Array(total);
  for (let index = 0; index < total; index += 1) {
    const seconds = index / SAMPLE_RATE;
    const value = glottalTone(seconds) * speechEnvelope(seconds) * 0.6;
    samples[index] = Math.round(Math.max(-1, Math.min(1, value)) * 32_000);
  }
  return samples;
}

/** 16-bit mono PCM, the same header shape the smoke tool writes. */
function encodeWav(samples: Int16Array): Uint8Array {
  const data = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  const out = new Uint8Array(44 + data.length);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) out[offset + index] = text.charCodeAt(index);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + data.length, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, data.length, true);
  out.set(data, 44);
  return out;
}

function insideEllipse(x: number, y: number, cx: number, cy: number, rx: number, ry: number): boolean {
  const dx = (x - cx) / rx;
  const dy = (y - cy) / ry;
  return dx * dx + dy * dy <= 1;
}

interface FaceShape {
  mouthOpening: number;
}

function shadeBackground(x: number, y: number): number {
  return 40 + Math.round((x / FRAME_WIDTH) * 24 + (y / FRAME_HEIGHT) * 16);
}

function shadeFace(x: number, y: number, shape: FaceShape): number | null {
  const cx = FRAME_WIDTH / 2;
  const cy = FRAME_HEIGHT / 2;
  if (!insideEllipse(x, y, cx, cy, 30, 40)) return null;
  if (insideEllipse(x, y, cx - 12, cy - 12, 5, 4)) return 30;
  if (insideEllipse(x, y, cx + 12, cy - 12, 5, 4)) return 30;
  if (insideEllipse(x, y, cx, cy + 16, 10, 2 + shape.mouthOpening * 8)) return 45;
  if (insideEllipse(x, y, cx, cy + 2, 4, 9)) return 175;
  return 205 - Math.round(((y - cy + 40) / 80) * 30);
}

function renderFrame(shape: FaceShape): GrayImage {
  const pixels = new Uint8Array(FRAME_WIDTH * FRAME_HEIGHT);
  for (let y = 0; y < FRAME_HEIGHT; y += 1) {
    for (let x = 0; x < FRAME_WIDTH; x += 1) {
      pixels[y * FRAME_WIDTH + x] = shadeFace(x, y, shape) ?? shadeBackground(x, y);
    }
  }
  return { width: FRAME_WIDTH, height: FRAME_HEIGHT, pixels };
}

function mouthOpeningAt(tsMs: number): number {
  return speechEnvelope(tsMs / 1_000) > 0.3 ? 1 : 0;
}

/** The board's VAD is a window, not an instant: a syllable gap is not silence. */
function speechWithin(tsMs: number, windowMs: number): boolean {
  for (let offset = 0; offset < windowMs; offset += 20) {
    if (speechEnvelope((tsMs + offset) / 1_000) > 0.2) return true;
  }
  return false;
}

function statusAt(tsMs: number): GlassesStatus {
  const speaking = speechWithin(tsMs, 1_000);
  return {
    type: 'status',
    ts_ms: tsMs,
    die_c: 41.5 + tsMs / 4_000,
    camera: speaking ? 'burst' : 'idle',
    vad: speaking,
    fps: speaking ? GLASSES_BURST_FPS : 0,
    audio_drops: 0,
    frame_drops: 0,
    heap_free: 214_000,
    psram_free: 7_800_000,
    rssi: -47,
  };
}

function writeFrames(): string[] {
  mkdirSync(join(here, 'frames'), { recursive: true });
  return FRAME_TIMES_MS.map((tsMs, index) => {
    const jpeg = encodeGrayJpeg(renderFrame({ mouthOpening: mouthOpeningAt(tsMs) }), JPEG_QUALITY);
    const file = `frames/${String(index).padStart(6, '0')}.jpg`;
    writeFileSync(join(here, file), jpeg);
    return JSON.stringify({
      file,
      seq: index,
      ts_ms: tsMs,
      width: FRAME_WIDTH,
      height: FRAME_HEIGHT,
      bytes: jpeg.byteLength,
    });
  });
}

function main(): void {
  const audio = encodeWav(renderAudio());
  writeFileSync(join(here, 'audio.wav'), audio);

  const frameLines = writeFrames();
  writeFileSync(join(here, 'frames.jsonl'), `${frameLines.join('\n')}\n`);

  const statusLines: string[] = [];
  for (let tsMs = 0; tsMs < DURATION_MS; tsMs += 1_000) {
    statusLines.push(JSON.stringify(statusAt(tsMs)));
  }
  writeFileSync(join(here, 'status.jsonl'), `${statusLines.join('\n')}\n`);

  const total = audio.byteLength + frameLines.reduce((sum, line) => sum + JSON.parse(line).bytes, 0);
  console.log(`wrote ${here}`);
  console.log(`  audio.wav     ${(audio.byteLength / 1024).toFixed(1)} KB, ${DURATION_MS / 1000}s at ${SAMPLE_RATE} Hz`);
  console.log(`  frames        ${frameLines.length} at ${FRAME_WIDTH}x${FRAME_HEIGHT}`);
  console.log(`  total media   ${(total / 1024).toFixed(1)} KB`);
}

main();
