import { describe, expect, it } from 'vitest';

import {
  adaptiveSNorm,
  calibratedProbability,
  cohortStats,
  decideSpeaker,
  equalErrorRate,
  errorRatesAt,
  fitCalibration,
  type Trial,
} from './score-norm';

describe('cohortStats', () => {
  it('takes the mean and sample spread of the scores it is given', () => {
    // mean 0.3; sample variance ((0.2^2) + 0 + (0.2^2)) / 2 = 0.04
    expect(cohortStats([0.5, 0.3, 0.1], 3)).toEqual({ mean: 0.3, stdDev: 0.2 });
  });

  it('keeps only the nearest imposters, which is what makes it adaptive', () => {
    const stats = cohortStats([0.5, 0.3, 0.1, 0.05], 2);
    expect(stats.mean).toBeCloseTo(0.4, 12);
    expect(stats.stdDev).toBeCloseTo(Math.sqrt(0.02), 12);
  });

  it('uses every score it has when asked for more than exist', () => {
    expect(cohortStats([0.5, 0.3, 0.1], 50)).toEqual({ mean: 0.3, stdDev: 0.2 });
  });

  it('does not divide by a spread of zero when every imposter scores alike', () => {
    expect(cohortStats([0.4, 0.4, 0.4], 3).stdDev).toBeGreaterThan(0);
  });

  it('survives a cohort of one, which has no spread to measure', () => {
    const stats = cohortStats([0.42], 5);
    expect(stats.mean).toBe(0.42);
    expect(stats.stdDev).toBeGreaterThan(0);
  });

  it('has no opinion when there are no imposters at all', () => {
    expect(cohortStats([], 5)).toEqual({ mean: 0, stdDev: 1e-6 });
  });

  it('ignores a NaN rather than letting it eat the whole cohort', () => {
    expect(cohortStats([0.5, Number.NaN, 0.3, 0.1], 3)).toEqual({ mean: 0.3, stdDev: 0.2 });
  });

  it('refuses a cohort size below one rather than silently taking none', () => {
    expect(() => cohortStats([0.5], 0)).toThrow(/at least 1/);
  });
});

describe('adaptiveSNorm', () => {
  it('averages the deviation measured from each side', () => {
    // (0.8 - 0.3)/0.2 = 2.5 from the test side, (0.8 - 0.4)/0.1 = 4 from the
    // enrolled side.
    const normalized = adaptiveSNorm(0.8, { mean: 0.3, stdDev: 0.2 }, { mean: 0.4, stdDev: 0.1 });
    expect(normalized).toBeCloseTo(3.25, 12);
  });

  it('scores a trial at the cohort mean as no evidence either way', () => {
    expect(adaptiveSNorm(0.3, { mean: 0.3, stdDev: 0.2 }, { mean: 0.3, stdDev: 0.2 })).toBe(0);
  });

  it('marks down a voice that is close to everybody', () => {
    // The same raw 0.6 against a generic voice, whose imposters already sit at
    // 0.55, and against a distinctive one whose imposters sit at 0.2.
    const generic = adaptiveSNorm(0.6, { mean: 0.55, stdDev: 0.05 }, { mean: 0.55, stdDev: 0.05 });
    const distinctive = adaptiveSNorm(0.6, { mean: 0.2, stdDev: 0.05 }, { mean: 0.2, stdDev: 0.05 });
    expect(distinctive).toBeGreaterThan(generic);
  });
});

describe('decideSpeaker', () => {
  const thresholds = { accept: 3, reject: 1, margin: 0.5 };

  it('accepts a clear winner', () => {
    expect(decideSpeaker([4, 1], thresholds)).toEqual({ kind: 'match', score: 4, margin: 3 });
  });

  it('refuses to choose between two candidates that both fit', () => {
    const decision = decideSpeaker([4, 3.8], thresholds);
    expect(decision).toEqual({
      kind: 'uncertain',
      reason: 'ambiguous',
      score: 4,
      margin: expect.closeTo(0.2, 12),
    });
  });

  it('waits rather than inventing a person when the evidence is merely thin', () => {
    expect(decideSpeaker([2, 0], thresholds)).toMatchObject({
      kind: 'uncertain',
      reason: 'below_accept',
    });
  });

  it('mints a new person only when nobody known is plausible', () => {
    expect(decideSpeaker([0.5, 0.1], thresholds)).toEqual({ kind: 'new', score: 0.5 });
  });

  it('treats a sole candidate as unopposed rather than ambiguous', () => {
    expect(decideSpeaker([4], thresholds)).toEqual({
      kind: 'match',
      score: 4,
      margin: Number.POSITIVE_INFINITY,
    });
  });

  it('calls an empty database a new person', () => {
    expect(decideSpeaker([], thresholds).kind).toBe('new');
  });

  it('does not let a NaN score become a match', () => {
    expect(decideSpeaker([Number.NaN], thresholds).kind).toBe('new');
  });
});

describe('errorRatesAt', () => {
  const trials: Trial[] = [
    { score: 0.9, genuine: true },
    { score: 0.7, genuine: true },
    { score: 0.4, genuine: false },
    { score: 0.2, genuine: false },
  ];

  it('counts nothing wrong at a threshold that separates the two cleanly', () => {
    expect(errorRatesAt(trials, 0.6)).toEqual({ falseAcceptRate: 0, falseRejectRate: 0 });
  });

  it('counts an imposter above the line as a false accept', () => {
    expect(errorRatesAt(trials, 0.3)).toEqual({ falseAcceptRate: 0.5, falseRejectRate: 0 });
  });

  it('counts a genuine trial below the line as a false reject', () => {
    expect(errorRatesAt(trials, 0.8)).toEqual({ falseAcceptRate: 0, falseRejectRate: 0.5 });
  });
});

describe('equalErrorRate', () => {
  it('is zero when the two distributions do not overlap', () => {
    expect(
      equalErrorRate([
        { score: 0.9, genuine: true },
        { score: 0.8, genuine: true },
        { score: 0.2, genuine: false },
        { score: 0.1, genuine: false },
      ]).eer,
    ).toBe(0);
  });

  it('rises as the distributions overlap', () => {
    const overlapping = equalErrorRate([
      { score: 0.9, genuine: true },
      { score: 0.3, genuine: true },
      { score: 0.8, genuine: false },
      { score: 0.1, genuine: false },
    ]);
    expect(overlapping.eer).toBeGreaterThan(0);
  });

  it('has nothing to measure without both kinds of trial', () => {
    expect(equalErrorRate([{ score: 0.9, genuine: true }]).eer).toBe(0);
  });
});

describe('fitCalibration', () => {
  it('turns separable scores into confident probabilities on the right sides', () => {
    const trials: Trial[] = [];
    for (let index = 0; index < 40; index += 1) {
      trials.push({ score: 3 + index / 40, genuine: true });
      trials.push({ score: -3 + index / 40, genuine: false });
    }

    const calibration = fitCalibration(trials);
    expect(calibratedProbability(4, calibration)).toBeGreaterThan(0.9);
    expect(calibratedProbability(-4, calibration)).toBeLessThan(0.1);
  });

  it('is monotonic, so calibration never reorders candidates', () => {
    const trials: Trial[] = [];
    for (let index = 0; index < 30; index += 1) {
      trials.push({ score: 1 + index / 10, genuine: true });
      trials.push({ score: -1 - index / 10, genuine: false });
    }

    const calibration = fitCalibration(trials);
    const probabilities = [-2, -1, 0, 1, 2].map((score) =>
      calibratedProbability(score, calibration),
    );

    for (let index = 1; index < probabilities.length; index += 1) {
      expect(probabilities[index]).toBeGreaterThan(probabilities[index - 1] as number);
    }
  });

  it('leans safe when it has only ever seen imposters', () => {
    const calibration = fitCalibration([
      { score: 0.2, genuine: false },
      { score: 0.3, genuine: false },
    ]);
    expect(calibratedProbability(0.9, calibration)).toBeLessThan(0.01);
  });

  it('has nothing to fit to and says so quietly', () => {
    expect(fitCalibration([])).toEqual({ slope: 1, intercept: 0 });
  });
});

/**
 * The reason any of this exists.
 *
 * Speakers differ in how close they sit to everybody else — a generic voice
 * scores well against half the database and a distinctive one scores badly
 * against all of it. That per-speaker offset is what a single global cosine
 * threshold cannot express, and it is what AS-norm removes.
 *
 * The simulation below is a faithful model of exactly that effect and of
 * nothing else: each speaker gets an offset, genuine trials get a fixed bonus,
 * and both get the same noise. No part of it is tuned to flatter the result —
 * the offsets and the bonus are chosen so that the raw distributions genuinely
 * overlap, which is the situation on real audio and the situation the shipped
 * fixture does not contain.
 */
describe('what AS-norm buys, on simulated per-speaker offsets', () => {
  // A tiny LCG so the numbers are identical on every machine and every run.
  function random(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
      return state / 4_294_967_296;
    };
  }

  function simulate() {
    const next = random(20_260_815);
    const speakers = 12;
    // How close each speaker sits to everyone. This is the nuisance term.
    const offset = Array.from({ length: speakers }, () => next() * 0.35);
    const genuineBonus = 0.25;
    const noise = () => (next() - 0.5) * 0.18;

    const raw: Trial[] = [];
    const normalized: Trial[] = [];

    for (let enrolled = 0; enrolled < speakers; enrolled += 1) {
      for (let test = 0; test < speakers; test += 1) {
        const genuine = enrolled === test;
        const score =
          0.3 +
          (offset[enrolled] as number) +
          (offset[test] as number) +
          (genuine ? genuineBonus : 0) +
          noise();

        // The cohort each side would see: its scores against everyone it is
        // known not to be. Built from the same model, excluding the true match.
        const cohortFor = (speaker: number) =>
          Array.from({ length: speakers }, (_unused, other) =>
            other === speaker
              ? Number.NaN
              : 0.3 + (offset[speaker] as number) + (offset[other] as number) + noise(),
          ).filter((value) => Number.isFinite(value));

        raw.push({ score, genuine });
        normalized.push({
          score: adaptiveSNorm(
            score,
            cohortStats(cohortFor(test), 8),
            cohortStats(cohortFor(enrolled), 8),
          ),
          genuine,
        });
      }
    }

    return { raw, normalized };
  }

  it('leaves the raw distributions genuinely overlapping, so the test is not rigged', () => {
    const { raw } = simulate();
    expect(equalErrorRate(raw).eer).toBeGreaterThan(0.05);
  });

  it('separates them better than raw cosine does', () => {
    const { raw, normalized } = simulate();
    expect(equalErrorRate(normalized).eer).toBeLessThan(equalErrorRate(raw).eer);
  });

  it('makes one threshold hold across speakers, which is the whole point', () => {
    const { raw, normalized } = simulate();

    // Fit the best single threshold on each scale, then ask how badly the worst
    // speaker is served by it. A threshold that works on average and fails one
    // person is the failure mode: that person is the one who shatters into six.
    const worstSpeakerError = (trials: Trial[], threshold: number) => {
      const perSpeaker: number[] = [];
      for (let index = 0; index < trials.length; index += 12) {
        const block = trials.slice(index, index + 12);
        const { falseAcceptRate, falseRejectRate } = errorRatesAt(block, threshold);
        perSpeaker.push(falseAcceptRate + falseRejectRate);
      }
      return Math.max(...perSpeaker);
    };

    const rawWorst = worstSpeakerError(raw, equalErrorRate(raw).threshold);
    const normalizedWorst = worstSpeakerError(
      normalized,
      equalErrorRate(normalized).threshold,
    );

    expect(normalizedWorst).toBeLessThanOrEqual(rawWorst);
  });
});
