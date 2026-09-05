/**
 * Which of the faces on screen is the one making the sound.
 *
 * The signal is correlation, not loudness: a mouth that opens and closes in
 * time with the audio envelope is speaking, and a mouth that happens to be
 * open is not. Openness is differentiated first because the envelope tracks
 * how the mouth is *moving*, and correlated at a lag because the phone's
 * camera and the board's mic arrive on different clocks.
 *
 * Pure arithmetic over injected samples, so a face and an audio track can be
 * fed in from a fixture and the answer asserted.
 */

import {
  ACTIVE_SPEAKER_MIN_SCORE,
  ACTIVE_SPEAKER_WINDOW_MS,
  OWNER_NEAR_FIELD_MARGIN_DB,
  type Id,
} from '../../shared/contracts';
import type { NormalizedPoint, VisionFace } from './vision';

/** 30 ms is the shortest window that still holds a syllable's worth of energy. */
export const ENVELOPE_HOP_MS = 30;
export const ENVELOPE_HOP_SAMPLES = 480;
/** Camera and mic are on different clocks; this is how far apart they may drift. */
export const MAX_LAG_MS = 200;
/** How much recent audio decides whether the wearer is the one talking. */
export const NEAR_FIELD_WINDOW_MS = 500;

function centroid(points: NormalizedPoint[]): NormalizedPoint | null {
  if (points.length === 0) return null;
  let x = 0;
  let y = 0;
  for (const point of points) {
    x += point.x;
    y += point.y;
  }
  return { x: x / points.length, y: y / points.length };
}

function verticalExtent(points: NormalizedPoint[]): number {
  let min = Infinity;
  let max = -Infinity;
  for (const point of points) {
    if (point.y < min) min = point.y;
    if (point.y > max) max = point.y;
  }
  return max > min ? max - min : 0;
}

/**
 * Inner-lip opening over inter-ocular distance.
 *
 * Divided by the eye distance so it means the same thing at any distance from
 * the camera: a face across the room and a face at arm's length open their
 * mouths by wildly different numbers of pixels and by the same fraction of
 * their own head.
 */
export function mouthOpenness(face: VisionFace): number | undefined {
  const landmarks = face.landmarks;
  if (!landmarks) return undefined;
  const left = centroid(landmarks.leftEye);
  const right = centroid(landmarks.rightEye);
  if (!left || !right) return undefined;
  const interocular = Math.hypot(right.x - left.x, right.y - left.y);
  if (interocular <= 0) return undefined;
  return verticalExtent(landmarks.innerLips) / interocular;
}

export interface TimedValue {
  ts_ms: number;
  value: number;
}

function pruneBefore(series: TimedValue[], cutoffMs: number): TimedValue[] {
  let first = 0;
  while (first < series.length && series[first].ts_ms < cutoffMs) first += 1;
  return first === 0 ? series : series.slice(first);
}

/** Linear interpolation onto a fixed grid, so two irregular series can be compared. */
function onGrid(series: TimedValue[], startMs: number, hopMs: number, count: number): number[] {
  const grid: number[] = new Array(count).fill(0);
  if (series.length === 0) return grid;
  let cursor = 0;
  for (let index = 0; index < count; index += 1) {
    const at = startMs + index * hopMs;
    while (cursor + 1 < series.length && series[cursor + 1].ts_ms <= at) cursor += 1;
    const low = series[cursor];
    const high = series[Math.min(cursor + 1, series.length - 1)];
    const span = high.ts_ms - low.ts_ms;
    const t = span > 0 ? Math.min(1, Math.max(0, (at - low.ts_ms) / span)) : 0;
    grid[index] = low.value * (1 - t) + high.value * t;
  }
  return grid;
}

function derivative(values: number[]): number[] {
  const out: number[] = new Array(Math.max(0, values.length - 1));
  for (let index = 1; index < values.length; index += 1) out[index - 1] = values[index] - values[index - 1];
  return out;
}

export function pearson(a: number[], b: number[]): number {
  const count = Math.min(a.length, b.length);
  if (count < 3) return 0;
  let sumA = 0;
  let sumB = 0;
  for (let index = 0; index < count; index += 1) {
    sumA += a[index];
    sumB += b[index];
  }
  const meanA = sumA / count;
  const meanB = sumB / count;
  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (let index = 0; index < count; index += 1) {
    const da = a[index] - meanA;
    const db = b[index] - meanB;
    covariance += da * db;
    varianceA += da * da;
    varianceB += db * db;
  }
  const denominator = Math.sqrt(varianceA * varianceB);
  return denominator > 0 ? covariance / denominator : 0;
}

function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) sum += samples[index] * samples[index];
  return Math.sqrt(sum / samples.length);
}

export function amplitudeDb(amplitude: number): number {
  return 20 * Math.log10(Math.max(amplitude, 1e-6));
}

/**
 * A rolling 30 ms RMS envelope of the glasses mic, plus the noise floor it is
 * measured against.
 *
 * The floor is an EMA over quiet hops only, so a long turn does not slowly
 * teach the tracker that speech is silence.
 */
export class AudioEnvelope {
  private series: TimedValue[] = [];
  private pending = new Float32Array(0);
  private pendingStartMs = 0;
  private floorDb = -60;
  private floorSeeded = false;

  constructor(private readonly windowMs: number = ACTIVE_SPEAKER_WINDOW_MS) {}

  get points(): readonly TimedValue[] {
    return this.series;
  }

  get noiseFloorDb(): number {
    return this.floorDb;
  }

  reset(): void {
    this.series = [];
    this.pending = new Float32Array(0);
    this.floorSeeded = false;
    this.floorDb = -60;
  }

  push(samples: Float32Array, tsMs: number): void {
    if (this.pending.length === 0) this.pendingStartMs = tsMs;
    const joined = new Float32Array(this.pending.length + samples.length);
    joined.set(this.pending);
    joined.set(samples, this.pending.length);

    let offset = 0;
    while (joined.length - offset >= ENVELOPE_HOP_SAMPLES) {
      const hop = joined.subarray(offset, offset + ENVELOPE_HOP_SAMPLES);
      const at = this.pendingStartMs + (offset / ENVELOPE_HOP_SAMPLES) * ENVELOPE_HOP_MS;
      this.record(at, rms(hop));
      offset += ENVELOPE_HOP_SAMPLES;
    }
    this.pendingStartMs += (offset / ENVELOPE_HOP_SAMPLES) * ENVELOPE_HOP_MS;
    this.pending = joined.slice(offset);
    this.series = pruneBefore(this.series, this.lastTsMs - this.windowMs);
  }

  private record(tsMs: number, amplitude: number): void {
    this.series.push({ ts_ms: tsMs, value: amplitude });
    const db = amplitudeDb(amplitude);
    if (!this.floorSeeded) {
      this.floorDb = db;
      this.floorSeeded = true;
      return;
    }
    if (db <= this.floorDb + OWNER_NEAR_FIELD_MARGIN_DB) this.floorDb += 0.05 * (db - this.floorDb);
  }

  get lastTsMs(): number {
    return this.series.length > 0 ? this.series[this.series.length - 1].ts_ms : 0;
  }

  /** Loudest recent level in dB, which is what "is the wearer talking" asks about. */
  levelDb(windowMs: number = NEAR_FIELD_WINDOW_MS): number {
    const cutoff = this.lastTsMs - windowMs;
    let peak = 0;
    for (const point of this.series) if (point.ts_ms >= cutoff && point.value > peak) peak = point.value;
    return amplitudeDb(peak);
  }

  /**
   * Speech loud enough to be the wearer rather than the room. The margin is a
   * placeholder until a real capture measures it.
   */
  isNearField(windowMs: number = NEAR_FIELD_WINDOW_MS): boolean {
    if (this.series.length === 0) return false;
    return this.levelDb(windowMs) >= this.floorDb + OWNER_NEAR_FIELD_MARGIN_DB;
  }
}

export class ActiveSpeakerScorer {
  private readonly openness = new Map<Id, TimedValue[]>();

  constructor(private readonly windowMs: number = ACTIVE_SPEAKER_WINDOW_MS) {}

  push(trackId: Id, openness: number, tsMs: number): void {
    const series = this.openness.get(trackId) ?? [];
    series.push({ ts_ms: tsMs, value: openness });
    this.openness.set(trackId, pruneBefore(series, tsMs - this.windowMs));
  }

  forget(trackId: Id): void {
    this.openness.delete(trackId);
  }

  reset(): void {
    this.openness.clear();
  }

  /**
   * Best correlation between how the mouth is moving and how loud the room is,
   * over lags the two clocks might plausibly differ by. Negative correlation is
   * not evidence of anything, so the floor is zero rather than -1.
   */
  score(trackId: Id, envelope: AudioEnvelope, nowMs: number): number {
    const series = this.openness.get(trackId);
    if (!series || series.length < 4 || envelope.points.length < 4) return 0;
    const count = Math.floor(this.windowMs / ENVELOPE_HOP_MS);
    const startMs = nowMs - this.windowMs;
    const motion = derivative(onGrid(series, startMs, ENVELOPE_HOP_MS, count));

    let best = 0;
    const maxLag = Math.floor(MAX_LAG_MS / ENVELOPE_HOP_MS);
    for (let lag = 0; lag <= maxLag; lag += 1) {
      const audio = onGrid(envelope.points as TimedValue[], startMs + lag * ENVELOPE_HOP_MS, ENVELOPE_HOP_MS, count - 1);
      const correlation = pearson(motion, audio);
      if (correlation > best) best = correlation;
    }
    return best;
  }
}

export interface SpeakerCandidate {
  track_id: Id;
  score: number;
}

/**
 * The one face credited with the audio, or nobody.
 *
 * Only asked while the board reports speech: with no speech there is no
 * envelope to correlate against, and the top of a list of noise is still
 * noise. A tie leaves it unattributed rather than picking arbitrarily.
 */
export function pickActiveSpeaker(candidates: SpeakerCandidate[], boardSpeaking: boolean): Id | null {
  if (!boardSpeaking) return null;
  const ranked = [...candidates].sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (!best || best.score < ACTIVE_SPEAKER_MIN_SCORE) return null;
  if (ranked[1] && ranked[1].score === best.score) return null;
  return best.track_id;
}
