import { describe, expect, it } from 'vitest';
import { ACTIVE_SPEAKER_MIN_SCORE, ACTIVE_SPEAKER_WINDOW_MS } from '../../shared/contracts';
import {
  ActiveSpeakerScorer,
  AudioEnvelope,
  ENVELOPE_HOP_MS,
  ENVELOPE_HOP_SAMPLES,
  mouthOpenness,
  pickActiveSpeaker,
} from './active-speaker';
import type { VisionFace } from './vision';

const HOPS = Math.floor(ACTIVE_SPEAKER_WINDOW_MS / ENVELOPE_HOP_MS);

/**
 * One turn: quiet, then half a second of speech, then quiet again.
 *
 * Deliberately not a periodic driver. The scorer searches lags up to 200 ms,
 * and anything that repeats faster than that lets an anti-correlated mouth
 * score as well as the real one by sliding half a period. A burst wider than
 * the search window cannot be rescued that way, which is the point.
 */
function loudness(index: number): number {
  return index >= 15 && index < 32 ? 0.45 : 0.02;
}

function constantFrame(amplitude: number): Float32Array {
  return new Float32Array(ENVELOPE_HOP_SAMPLES).fill(amplitude);
}

/**
 * A mouth whose *rate of change* follows the loudness is the one speaking, so the
 * in-phase track is the running sum of the mean-removed envelope and the
 * out-of-phase track is its negation.
 */
function drive(scorer: ActiveSpeakerScorer, envelope: AudioEnvelope): void {
  const mean = Array.from({ length: HOPS }, (_, index) => loudness(index)).reduce((a, b) => a + b, 0) / HOPS;
  let inPhase = 0;
  let outOfPhase = 0;
  for (let index = 0; index < HOPS; index += 1) {
    const at = index * ENVELOPE_HOP_MS;
    envelope.push(constantFrame(loudness(index)), at);
    scorer.push('in', 0.2 + inPhase, at);
    scorer.push('out', 0.2 + outOfPhase, at);
    inPhase += (loudness(index) - mean) * 0.1;
    outOfPhase -= (loudness(index) - mean) * 0.1;
  }
}

describe('mouth openness', () => {
  it('measures the inner lip opening against the eye distance', () => {
    const face: VisionFace = {
      bbox: { x: 0.3, y: 0.3, width: 0.4, height: 0.4 },
      landmarks: {
        leftEye: [{ x: 0.4, y: 0.4 }],
        rightEye: [{ x: 0.6, y: 0.4 }],
        innerLips: [{ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.54 }],
        outerLips: [{ x: 0.5, y: 0.48 }, { x: 0.5, y: 0.56 }],
      },
    };
    expect(mouthOpenness(face)).toBeCloseTo(0.2, 6);
  });

  it('has no answer without landmarks', () => {
    expect(mouthOpenness({ bbox: { x: 0, y: 0, width: 0.5, height: 0.5 } })).toBeUndefined();
  });
});

describe('active speaker scoring', () => {
  it('scores the in-phase face above the out-of-phase one', () => {
    const envelope = new AudioEnvelope();
    const scorer = new ActiveSpeakerScorer();
    drive(scorer, envelope);
    const now = (HOPS - 1) * ENVELOPE_HOP_MS;

    const inPhase = scorer.score('in', envelope, now);
    const outOfPhase = scorer.score('out', envelope, now);
    expect(inPhase).toBeGreaterThan(ACTIVE_SPEAKER_MIN_SCORE);
    expect(inPhase).toBeGreaterThan(outOfPhase);
    expect(outOfPhase).toBeLessThan(ACTIVE_SPEAKER_MIN_SCORE);
  });

  it('has no score for a track it has not seen', () => {
    const envelope = new AudioEnvelope();
    expect(new ActiveSpeakerScorer().score('nobody', envelope, 0)).toBe(0);
  });

  it('picks the in-phase track only while the board hears speech', () => {
    const envelope = new AudioEnvelope();
    const scorer = new ActiveSpeakerScorer();
    drive(scorer, envelope);
    const now = (HOPS - 1) * ENVELOPE_HOP_MS;
    const candidates = [
      { track_id: 'in', score: scorer.score('in', envelope, now) },
      { track_id: 'out', score: scorer.score('out', envelope, now) },
    ];
    expect(pickActiveSpeaker(candidates, true)).toBe('in');
    expect(pickActiveSpeaker(candidates, false)).toBeNull();
  });

  it('credits nobody when the best score is weak or tied', () => {
    expect(pickActiveSpeaker([{ track_id: 'a', score: 0.1 }], true)).toBeNull();
    expect(pickActiveSpeaker([{ track_id: 'a', score: 0.9 }, { track_id: 'b', score: 0.9 }], true)).toBeNull();
    expect(pickActiveSpeaker([], true)).toBeNull();
  });
});

describe('audio envelope', () => {
  it('calls a quiet room near-field only once something is loud in it', () => {
    const envelope = new AudioEnvelope();
    for (let index = 0; index < 20; index += 1) envelope.push(constantFrame(0.002), index * ENVELOPE_HOP_MS);
    expect(envelope.isNearField()).toBe(false);

    for (let index = 20; index < 30; index += 1) envelope.push(constantFrame(0.4), index * ENVELOPE_HOP_MS);
    expect(envelope.isNearField()).toBe(true);
  });

  it('keeps only the correlation window', () => {
    const envelope = new AudioEnvelope();
    for (let index = 0; index < HOPS * 3; index += 1) envelope.push(constantFrame(0.1), index * ENVELOPE_HOP_MS);
    expect(envelope.points.length).toBeLessThanOrEqual(HOPS + 1);
  });
});
