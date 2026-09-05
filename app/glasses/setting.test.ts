import { describe, expect, it } from 'vitest';
import { SETTING_HYSTERESIS_S, SETTING_PERSISTENT_TRACK_MS } from '../../shared/contracts';
import type { FaceTrack } from './face-tracker';
import {
  DEFAULT_CAPTURE_MODE,
  SettingClassifier,
  classify,
  featuresFrom,
  type SettingFeatures,
  type VadSample,
} from './setting';

const NOW = 100_000;

function track(options: { near: boolean; lifetimeMs: number; lastSeenAgoMs?: number }): FaceTrack {
  const lastSeen = NOW - (options.lastSeenAgoMs ?? 0);
  const size = options.near ? 0.4 : 0.05;
  return {
    track_id: `t-${Math.random()}`,
    bbox: { x: 0.1, y: 0.1, width: size, height: size },
    face: { bbox: { x: 0.1, y: 0.1, width: size, height: size } },
    first_seen_ms: lastSeen - options.lifetimeMs,
    last_seen_ms: lastSeen,
    frames: 4,
    is_near: options.near,
  };
}

const features = (overrides: Partial<SettingFeatures> = {}): SettingFeatures => ({
  nearFaces: 0,
  persistentTracks: 0,
  transientPerMinute: 0,
  voiceDensity: 0,
  ...overrides,
});

const street = features({ transientPerMinute: 6 });
const group = features({ nearFaces: 1, persistentTracks: 1 });
const gathering = features({ persistentTracks: 5 });

describe('setting features', () => {
  it('counts near faces, persistent tracks and churn', () => {
    const vad: VadSample[] = [
      { ts_ms: NOW - 3_000, speech: true },
      { ts_ms: NOW - 2_000, speech: false },
      { ts_ms: NOW - 1_000, speech: true },
    ];
    const measured = featuresFrom(
      [
        track({ near: true, lifetimeMs: SETTING_PERSISTENT_TRACK_MS + 1_000 }),
        track({ near: false, lifetimeMs: 500, lastSeenAgoMs: 20_000 }),
        track({ near: false, lifetimeMs: 900, lastSeenAgoMs: 30_000 }),
      ],
      vad,
      NOW,
    );
    expect(measured.nearFaces).toBe(1);
    expect(measured.persistentTracks).toBe(1);
    expect(measured.transientPerMinute).toBe(2);
    expect(measured.voiceDensity).toBeCloseTo(2 / 3, 6);
  });

  it('forgets tracks older than the churn window', () => {
    const measured = featuresFrom([track({ near: true, lifetimeMs: 500, lastSeenAgoMs: 90_000 })], [], NOW);
    expect(measured.transientPerMinute).toBe(0);
    expect(measured.nearFaces).toBe(0);
  });
});

describe('classify', () => {
  it('reads a pavement as street', () => {
    expect(classify(street)).toBe('street');
  });

  it('reads one companion as group', () => {
    expect(classify(group)).toBe('group');
  });

  it('reads a crowd as gathering, by persistent tracks or by near faces plus voice', () => {
    expect(classify(gathering)).toBe('gathering');
    expect(classify(features({ nearFaces: 3, persistentTracks: 2, voiceDensity: 0.8 }))).toBe('gathering');
  });

  it('has no opinion when nothing says anything', () => {
    expect(classify(features())).toBeNull();
    expect(classify(features({ transientPerMinute: 2 }))).toBeNull();
  });
});

describe('setting classifier', () => {
  it('starts in group, the mode that keeps everything', () => {
    expect(new SettingClassifier().mode).toBe(DEFAULT_CAPTURE_MODE);
    expect(new SettingClassifier().mode).toBe('group');
  });

  it('only changes after the hysteresis holds', () => {
    const classifier = new SettingClassifier();
    for (let second = 1; second < SETTING_HYSTERESIS_S; second += 1) {
      expect(classifier.push(street)).toBe('group');
    }
    expect(classifier.push(street)).toBe('street');
  });

  it('a disagreeing second restarts the count', () => {
    const classifier = new SettingClassifier();
    classifier.push(street);
    classifier.push(street);
    classifier.push(gathering);
    for (let second = 1; second < SETTING_HYSTERESIS_S; second += 1) classifier.push(street);
    expect(classifier.mode).toBe('group');
    expect(classifier.push(street)).toBe('street');
  });

  it('a pin outranks everything observed until it is lifted', () => {
    const classifier = new SettingClassifier();
    classifier.pin('street');
    expect(classifier.pinned).toBe(true);
    for (let second = 0; second < SETTING_HYSTERESIS_S * 2; second += 1) classifier.push(gathering);
    expect(classifier.mode).toBe('street');
    classifier.unpin();
    expect(classifier.mode).toBe('gathering');
  });

  it('reset forgets the room and the pin', () => {
    const classifier = new SettingClassifier();
    classifier.pin('gathering');
    for (let second = 0; second < SETTING_HYSTERESIS_S; second += 1) classifier.push(street);
    classifier.reset();
    expect(classifier.mode).toBe('group');
    expect(classifier.pinned).toBe(false);
  });
});
