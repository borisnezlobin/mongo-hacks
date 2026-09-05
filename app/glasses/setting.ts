/**
 * What the wearer is in, decided from what the camera and mic can see.
 *
 * The mode is not cosmetic: it decides whether a companion's speech may start
 * a recording at all, and whether strangers' lines survive the final pass. So
 * it changes slowly and on evidence — a lone classification is an opinion, and
 * only SETTING_HYSTERESIS_S agreeing ones in a row are an answer.
 */

import {
  SETTING_HYSTERESIS_S,
  SETTING_PERSISTENT_TRACK_MS,
  SETTING_TRANSIENT_TRACK_MS,
  type CaptureMode,
} from '../../shared/contracts';
import type { FaceTrack } from './face-tracker';

/** Churn is measured over a minute, so the count is already the rate. */
export const CHURN_WINDOW_MS = 60_000;
/** A track not updated this recently is not on screen any more. */
export const VISIBLE_WITHIN_MS = 2_000;
export const STREET_TRANSIENTS_PER_MINUTE = 4;
export const GATHERING_PERSISTENT_TRACKS = 4;
export const GATHERING_NEAR_FACES = 3;
export const GATHERING_VOICE_DENSITY = 0.5;
export const GROUP_MAX_PERSISTENT_TRACKS = 3;

export const DEFAULT_CAPTURE_MODE: CaptureMode = 'group';

export interface VadSample {
  ts_ms: number;
  speech: boolean;
}

export interface SettingFeatures {
  nearFaces: number;
  persistentTracks: number;
  transientPerMinute: number;
  /** Fraction of the last minute the board reported speech. */
  voiceDensity: number;
}

function lifetimeMs(track: FaceTrack): number {
  return track.last_seen_ms - track.first_seen_ms;
}

function voiceDensityOf(vadHistory: readonly VadSample[], nowMs: number): number {
  const recent = vadHistory.filter((sample) => nowMs - sample.ts_ms <= CHURN_WINDOW_MS);
  if (recent.length === 0) return 0;
  return recent.filter((sample) => sample.speech).length / recent.length;
}

/**
 * Tracks are every face seen in the last minute, live or lost: churn is the
 * signal that separates a pavement from a room, and a tracker that only
 * remembers what is on screen cannot see churn at all.
 */
export function featuresFrom(
  tracks: readonly FaceTrack[],
  vadHistory: readonly VadSample[],
  nowMs: number,
): SettingFeatures {
  const recent = tracks.filter((track) => nowMs - track.last_seen_ms <= CHURN_WINDOW_MS);
  return {
    nearFaces: recent.filter(
      (track) => track.is_near && nowMs - track.last_seen_ms <= VISIBLE_WITHIN_MS,
    ).length,
    persistentTracks: recent.filter((track) => lifetimeMs(track) >= SETTING_PERSISTENT_TRACK_MS).length,
    transientPerMinute: recent.filter((track) => lifetimeMs(track) < SETTING_TRANSIENT_TRACK_MS).length,
    voiceDensity: voiceDensityOf(vadHistory, nowMs),
  };
}

function isGathering(features: SettingFeatures): boolean {
  if (features.persistentTracks >= GATHERING_PERSISTENT_TRACKS) return true;
  return features.nearFaces >= GATHERING_NEAR_FACES && features.voiceDensity > GATHERING_VOICE_DENSITY;
}

function isStreet(features: SettingFeatures): boolean {
  return features.nearFaces === 0 && features.transientPerMinute >= STREET_TRANSIENTS_PER_MINUTE;
}

function isGroup(features: SettingFeatures): boolean {
  return features.nearFaces >= 1
    && features.persistentTracks <= GROUP_MAX_PERSISTENT_TRACKS
    && features.transientPerMinute < STREET_TRANSIENTS_PER_MINUTE;
}

/**
 * Null is a real answer: "nothing here says anything". A classifier that always
 * names a mode would drag the setting around on one quiet second.
 *
 * Gathering is tested first because a crowded room satisfies the group rule too,
 * and the more specific reading is the true one.
 */
export function classify(features: SettingFeatures): CaptureMode | null {
  if (isGathering(features)) return 'gathering';
  if (isStreet(features)) return 'street';
  if (isGroup(features)) return 'group';
  return null;
}

export class SettingClassifier {
  private current: CaptureMode = DEFAULT_CAPTURE_MODE;
  private pinnedMode: CaptureMode | null = null;
  private candidate: CaptureMode | null = null;
  private agreements = 0;

  constructor(private readonly hysteresis: number = SETTING_HYSTERESIS_S) {}

  /** What the rest of the app reads. A pin outranks anything observed. */
  get mode(): CaptureMode {
    return this.pinnedMode ?? this.current;
  }

  get pinned(): boolean {
    return this.pinnedMode !== null;
  }

  /** One second of evidence. Returns the mode in force after it. */
  push(features: SettingFeatures): CaptureMode {
    const proposed = classify(features);
    if (!proposed || proposed === this.current) {
      this.candidate = null;
      this.agreements = 0;
      return this.mode;
    }
    if (proposed !== this.candidate) {
      this.candidate = proposed;
      this.agreements = 1;
    } else {
      this.agreements += 1;
    }
    if (this.agreements >= this.hysteresis) {
      this.current = proposed;
      this.candidate = null;
      this.agreements = 0;
    }
    return this.mode;
  }

  /** The owner's one tap. Observation keeps running underneath and is ignored. */
  pin(mode: CaptureMode): void {
    this.pinnedMode = mode;
  }

  unpin(): void {
    this.pinnedMode = null;
  }

  /** The link dropped: what the classifier believed about a room it can no longer see is stale. */
  reset(): void {
    this.current = DEFAULT_CAPTURE_MODE;
    this.pinnedMode = null;
    this.candidate = null;
    this.agreements = 0;
  }
}
