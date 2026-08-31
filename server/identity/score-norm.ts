/**
 * Adaptive score normalization and calibration for speaker matching.
 *
 * Attribution currently compares a raw cosine against a fixed constant. That
 * constant was fitted to one fixture, and the reason it did not survive contact
 * with a stage is structural rather than careless: raw cosine is not comparable
 * across speakers or rooms. Some voices sit close to everyone — a generic voice
 * scores 0.55 against half the database — and a single global number cannot
 * express "0.55 is remarkable for this speaker but unremarkable for that one".
 *
 * AS-norm makes the score relative instead of absolute. A trial is scored
 * against a cohort of people it is definitely NOT, from both sides, and the
 * result is expressed in standard deviations above that background. A generic
 * voice has a high cohort mean, so its raw 0.55 normalizes down; a distinctive
 * voice has a low one, so the same 0.55 normalizes up. One threshold then holds
 * across speakers, which is exactly the property the fixed cosine lacked.
 *
 * Nothing here touches audio. These are functions over scores, which is why
 * they can be tested exactly without a sidecar, a model, or a microphone.
 *
 * Reference: Matejka et al., "Analysis of Score Normalization in Multilingual
 * Speaker Recognition", Interspeech 2017.
 */

/** Mean and spread of a trial against people it is known not to be. */
export interface CohortStats {
  readonly mean: number;
  readonly stdDev: number;
}

/**
 * A standard deviation of zero is not a measurement, it is a degenerate cohort —
 * one imposter, or several with identical scores. Dividing by it yields Infinity
 * and poisons every downstream comparison, so it is floored instead. The floor
 * is small enough never to matter when the cohort is real.
 */
const MIN_STD_DEV = 1e-6;

/**
 * How many of the nearest imposters to normalize against.
 *
 * "Adaptive" means taking the most similar imposters rather than a random
 * sample: the useful question is how this trial compares to the people it is
 * most likely to be confused with, and averaging in obviously-different voices
 * only dilutes that. Values between 100 and 400 are usual in the literature;
 * this is far lower because an early user's database holds tens of people, not
 * thousands. Revisit it once a real corpus exists.
 */
export const DEFAULT_COHORT_SIZE = 20;

/**
 * Statistics of the top-K scores, which is the "adaptive" half of AS-norm.
 *
 * Uses the sample standard deviation (n-1). With a handful of imposters the
 * population form is biased low, and a too-small spread inflates every
 * normalized score — the direction that causes false matches.
 */
export function cohortStats(
  scores: readonly number[],
  topK: number = DEFAULT_COHORT_SIZE,
): CohortStats {
  if (topK < 1) throw new Error(`cohort size must be at least 1, got ${topK}`);

  const usable = scores.filter((score) => Number.isFinite(score));
  if (usable.length === 0) return { mean: 0, stdDev: MIN_STD_DEV };

  const top = [...usable].sort((a, b) => b - a).slice(0, topK);
  const mean = top.reduce((total, score) => total + score, 0) / top.length;

  if (top.length < 2) return { mean, stdDev: MIN_STD_DEV };

  const variance =
    top.reduce((total, score) => total + (score - mean) ** 2, 0) / (top.length - 1);

  return { mean, stdDev: Math.max(Math.sqrt(variance), MIN_STD_DEV) };
}

/**
 * The symmetric form: normalize from the test side and the enrolled side, then
 * average.
 *
 * Both halves are needed and they catch different things. The test-side term
 * asks "is this utterance unusually close to that person, given how close it is
 * to everyone?" — it suppresses a generic-sounding recording that matches the
 * whole database. The enrolled-side term asks the mirror question and suppresses
 * a stored voiceprint that attracts everybody, which is how one person slowly
 * swallows a database.
 */
export function adaptiveSNorm(
  trialScore: number,
  testSide: CohortStats,
  enrolledSide: CohortStats,
): number {
  const fromTest = (trialScore - testSide.mean) / testSide.stdDev;
  const fromEnrolled = (trialScore - enrolledSide.mean) / enrolledSide.stdDev;
  return (fromTest + fromEnrolled) / 2;
}

export type SpeakerDecision =
  | { kind: 'match'; score: number; margin: number }
  | { kind: 'uncertain'; reason: 'below_accept' | 'ambiguous'; score: number; margin: number }
  | { kind: 'new'; score: number };

export interface DecisionThresholds {
  /** At or above this, the best candidate is accepted. */
  readonly accept: number;
  /**
   * Below this, nobody in the database is plausible and a new person is minted.
   * Between the two is the honest middle the current code has no word for.
   */
  readonly reject: number;
  /**
   * How far the best candidate must beat the runner-up. Two people who both
   * score well means the evidence names a pair, not a person — and picking the
   * higher of two near-identical scores is a coin toss that silently merges
   * someone's history into someone else's.
   */
  readonly margin: number;
}

/**
 * Three outcomes, not two.
 *
 * The shipped rule mints a new person the instant the threshold is missed, so a
 * stranger and a badly-recorded friend are indistinguishable. They should not
 * be: a stranger is a new person, and a friend heard poorly is a reason to wait
 * for more audio. `uncertain` is what lets the caller wait — the UI already has
 * a word for it, because `speaker_pending` renders "Attributing…".
 *
 * Scores here are expected to be AS-normed, so the thresholds are in standard
 * deviations rather than cosine units.
 */
export function decideSpeaker(
  rankedScores: readonly number[],
  thresholds: DecisionThresholds,
): SpeakerDecision {
  const [best, runnerUp] = rankedScores;

  if (best === undefined || !Number.isFinite(best)) {
    return { kind: 'new', score: Number.NEGATIVE_INFINITY };
  }

  // No runner-up means nobody to be confused with, so the margin is unbounded
  // rather than zero. Treating a sole candidate as ambiguous would make the
  // very first person unattributable forever.
  const margin =
    runnerUp === undefined || !Number.isFinite(runnerUp)
      ? Number.POSITIVE_INFINITY
      : best - runnerUp;

  if (best < thresholds.reject) return { kind: 'new', score: best };
  if (best < thresholds.accept) {
    return { kind: 'uncertain', reason: 'below_accept', score: best, margin };
  }
  if (margin < thresholds.margin) {
    return { kind: 'uncertain', reason: 'ambiguous', score: best, margin };
  }

  return { kind: 'match', score: best, margin };
}

/** One scored comparison with a known answer, for fitting and measuring. */
export interface Trial {
  readonly score: number;
  readonly genuine: boolean;
}

/**
 * Maps a score to log-odds that the trial is genuine: `slope * score + intercept`.
 */
export interface Calibration {
  readonly slope: number;
  readonly intercept: number;
}

export function calibratedLogOdds(score: number, calibration: Calibration): number {
  return calibration.slope * score + calibration.intercept;
}

export function calibratedProbability(score: number, calibration: Calibration): number {
  return 1 / (1 + Math.exp(-calibratedLogOdds(score, calibration)));
}

/**
 * Fit score → probability by logistic regression on labelled trials.
 *
 * The point is not accuracy, which calibration does not change — the ranking is
 * identical. The point is that a probability can be reasoned about and a cosine
 * cannot. "Accept above 0.6" is a number nobody can defend; "accept when we are
 * 95% sure, because merging two people is far worse than leaving one unnamed"
 * is a product decision with an argument behind it. Once scores are
 * probabilities the operating point follows from the cost of each mistake
 * instead of from whatever the last fixture happened to produce.
 *
 * Plain gradient ascent on the log-likelihood. Deterministic, no dependency,
 * and fast enough at any corpus this will see for years.
 */
export function fitCalibration(
  trials: readonly Trial[],
  options: { iterations?: number; learningRate?: number } = {},
): Calibration {
  const usable = trials.filter((trial) => Number.isFinite(trial.score));
  const iterations = options.iterations ?? 2_000;
  const learningRate = options.learningRate ?? 0.1;

  if (usable.length === 0) return { slope: 1, intercept: 0 };

  // With only one class present there is no boundary to find. Returning a flat
  // fit that leans the right way beats returning a confident nonsense one.
  const genuineCount = usable.filter((trial) => trial.genuine).length;
  if (genuineCount === 0) return { slope: 0, intercept: -10 };
  if (genuineCount === usable.length) return { slope: 0, intercept: 10 };

  // Standardising first keeps the step size meaningful whether scores arrive as
  // cosines in [-1,1] or as AS-normed values spanning tens of deviations. The
  // fit is un-standardised at the end so callers never see the scaling.
  const mean = usable.reduce((total, trial) => total + trial.score, 0) / usable.length;
  const spread =
    Math.sqrt(
      usable.reduce((total, trial) => total + (trial.score - mean) ** 2, 0) / usable.length,
    ) || 1;

  let slope = 0;
  let intercept = 0;

  for (let step = 0; step < iterations; step += 1) {
    let slopeGradient = 0;
    let interceptGradient = 0;

    for (const trial of usable) {
      const standardised = (trial.score - mean) / spread;
      const predicted = 1 / (1 + Math.exp(-(slope * standardised + intercept)));
      const error = (trial.genuine ? 1 : 0) - predicted;
      slopeGradient += error * standardised;
      interceptGradient += error;
    }

    slope += (learningRate * slopeGradient) / usable.length;
    intercept += (learningRate * interceptGradient) / usable.length;
  }

  return { slope: slope / spread, intercept: intercept - (slope * mean) / spread };
}

export interface ErrorRates {
  /** Imposters wrongly accepted — in this product, two people merged into one. */
  readonly falseAcceptRate: number;
  /** Genuine trials wrongly rejected — one person split in two. */
  readonly falseRejectRate: number;
}

export function errorRatesAt(trials: readonly Trial[], threshold: number): ErrorRates {
  const genuine = trials.filter((trial) => trial.genuine);
  const imposter = trials.filter((trial) => !trial.genuine);

  const falseAccepts = imposter.filter((trial) => trial.score >= threshold).length;
  const falseRejects = genuine.filter((trial) => trial.score < threshold).length;

  return {
    falseAcceptRate: imposter.length === 0 ? 0 : falseAccepts / imposter.length,
    falseRejectRate: genuine.length === 0 ? 0 : falseRejects / genuine.length,
  };
}

/**
 * Equal error rate, and the threshold where it occurs.
 *
 * EER is the single number that says how separable two score distributions are,
 * independent of where the threshold happens to sit — which makes it the honest
 * way to compare raw cosine against a normalized score. A change that lowers EER
 * genuinely improved the discriminator; a change that only moves the threshold
 * traded one error for the other and improved nothing.
 *
 * Every observed score is tried as a candidate rather than sweeping a grid, so
 * the answer does not depend on a step size.
 */
export function equalErrorRate(trials: readonly Trial[]): {
  eer: number;
  threshold: number;
} {
  const usable = trials.filter((trial) => Number.isFinite(trial.score));
  const hasGenuine = usable.some((trial) => trial.genuine);
  const hasImposter = usable.some((trial) => !trial.genuine);

  if (!hasGenuine || !hasImposter) return { eer: 0, threshold: 0 };

  const candidates = [...new Set(usable.map((trial) => trial.score))].sort((a, b) => a - b);

  let best = { eer: 1, threshold: candidates[0] as number, gap: Number.POSITIVE_INFINITY };

  for (const threshold of candidates) {
    const { falseAcceptRate, falseRejectRate } = errorRatesAt(usable, threshold);
    const gap = Math.abs(falseAcceptRate - falseRejectRate);
    if (gap < best.gap) {
      best = { eer: (falseAcceptRate + falseRejectRate) / 2, threshold, gap };
    }
  }

  return { eer: best.eer, threshold: best.threshold };
}
