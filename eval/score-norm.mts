/**
 * What score normalization buys, measured rather than asserted.
 *
 * Two modes.
 *
 * Default, no arguments: a simulation. Speakers differ in how close they sit to
 * everybody else, genuine trials get a fixed bonus, and both get the same noise.
 * That per-speaker offset is the one effect AS-norm exists to remove, so the
 * simulation models it and nothing else. It is not evidence about ECAPA, real
 * rooms, or real people — it demonstrates that the mechanism does what it
 * claims on the failure it targets, which is as much as arithmetic can show.
 *
 *   bun run eval:score-norm
 *
 * With `--embeddings <file>`: the same measurement over real vectors. The file
 * is JSON, `[{ "speaker": "maya", "embedding": [...] }, ...]`, several rows per
 * speaker. Every pair becomes a trial, genuine when the speakers match. THIS is
 * the number that decides anything, and producing that file needs recorded
 * human audio through the sidecar — see the note at the bottom of this file.
 *
 *   bun run eval:score-norm -- --embeddings recorded.json
 */

import { readFileSync } from 'node:fs';

import {
  adaptiveSNorm,
  calibratedProbability,
  cohortStats,
  equalErrorRate,
  errorRatesAt,
  fitCalibration,
  type Trial,
} from '../server/identity/score-norm';

const SPEAKERS = 12;
const COHORT = 8;

/** Deterministic, so two runs on two machines print the same table. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index] as number;
    const right = b[index] as number;
    dot += left * right;
    leftMagnitude += left * left;
    rightMagnitude += right * right;
  }
  const denominator = Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude);
  return denominator === 0 ? 0 : dot / denominator;
}

interface Comparison {
  raw: Trial[];
  normalized: Trial[];
  blockSize: number;
}

function simulated(): Comparison {
  const next = random(20_260_815);
  const offset = Array.from({ length: SPEAKERS }, () => next() * 0.35);
  const noise = () => (next() - 0.5) * 0.18;

  const raw: Trial[] = [];
  const normalized: Trial[] = [];

  const cohortFor = (speaker: number) =>
    Array.from({ length: SPEAKERS }, (_unused, other) =>
      other === speaker
        ? Number.NaN
        : 0.3 + (offset[speaker] as number) + (offset[other] as number) + noise(),
    ).filter((value) => Number.isFinite(value));

  for (let enrolled = 0; enrolled < SPEAKERS; enrolled += 1) {
    for (let test = 0; test < SPEAKERS; test += 1) {
      const genuine = enrolled === test;
      const score =
        0.3 +
        (offset[enrolled] as number) +
        (offset[test] as number) +
        (genuine ? 0.25 : 0) +
        noise();

      raw.push({ score, genuine });
      normalized.push({
        score: adaptiveSNorm(
          score,
          cohortStats(cohortFor(test), COHORT),
          cohortStats(cohortFor(enrolled), COHORT),
        ),
        genuine,
      });
    }
  }

  return { raw, normalized, blockSize: SPEAKERS };
}

function fromEmbeddings(path: string): Comparison {
  const rows = JSON.parse(readFileSync(path, 'utf8')) as Array<{
    speaker: string;
    embedding: number[];
  }>;

  if (rows.length < 4) throw new Error(`need at least 4 rows, got ${rows.length}`);

  const raw: Trial[] = [];
  const normalized: Trial[] = [];

  // Every row's scores against every row that is definitely not the same
  // speaker. This is the cohort: it must exclude the true match, or the
  // normalization is measuring the answer.
  const cohortFor = (index: number) =>
    rows
      .map((other, otherIndex) =>
        otherIndex === index || other.speaker === (rows[index] as (typeof rows)[number]).speaker
          ? Number.NaN
          : cosine(
              (rows[index] as (typeof rows)[number]).embedding,
              other.embedding,
            ),
      )
      .filter((value) => Number.isFinite(value));

  const cohorts = rows.map((_row, index) => cohortStats(cohortFor(index), COHORT));

  for (let enrolled = 0; enrolled < rows.length; enrolled += 1) {
    for (let test = 0; test < rows.length; test += 1) {
      if (enrolled === test) continue;
      const score = cosine(
        (rows[enrolled] as (typeof rows)[number]).embedding,
        (rows[test] as (typeof rows)[number]).embedding,
      );
      const genuine =
        (rows[enrolled] as (typeof rows)[number]).speaker ===
        (rows[test] as (typeof rows)[number]).speaker;

      raw.push({ score, genuine });
      normalized.push({
        score: adaptiveSNorm(
          score,
          cohorts[test] as ReturnType<typeof cohortStats>,
          cohorts[enrolled] as ReturnType<typeof cohortStats>,
        ),
        genuine,
      });
    }
  }

  return { raw, normalized, blockSize: rows.length - 1 };
}

/**
 * The worst speaker's total error at one global threshold.
 *
 * Average accuracy hides the failure that matters. A threshold that serves
 * eleven speakers well and one badly is not a good threshold — the one it fails
 * is the person who shatters into six, or who quietly absorbs somebody else's
 * history. This is the number that should go down.
 */
function worstBlockError(trials: readonly Trial[], threshold: number, blockSize: number): number {
  const totals: number[] = [];
  for (let index = 0; index < trials.length; index += blockSize) {
    const block = trials.slice(index, index + blockSize);
    if (block.length === 0) continue;
    const { falseAcceptRate, falseRejectRate } = errorRatesAt(block, threshold);
    totals.push(falseAcceptRate + falseRejectRate);
  }
  return totals.length === 0 ? 0 : Math.max(...totals);
}

function report(label: string, trials: readonly Trial[], blockSize: number): void {
  const { eer, threshold } = equalErrorRate(trials);
  const worst = worstBlockError(trials, threshold, blockSize);
  console.log(
    `  ${label.padEnd(11)} EER ${(eer * 100).toFixed(1).padStart(5)}%` +
      `   best threshold ${threshold.toFixed(3).padStart(7)}` +
      `   worst speaker ${worst.toFixed(3)}`,
  );
}

function main(): void {
  const flagIndex = process.argv.indexOf('--embeddings');
  const path = flagIndex === -1 ? undefined : process.argv[flagIndex + 1];

  const { raw, normalized, blockSize } = path ? fromEmbeddings(path) : simulated();

  console.log('');
  if (path) {
    console.log(`Real embeddings from ${path}`);
  } else {
    console.log('SIMULATED per-speaker offsets — not evidence about real audio.');
    console.log('Run with --embeddings <file> once recorded human audio exists.');
  }
  console.log(`${raw.length} trials, ${raw.filter((trial) => trial.genuine).length} genuine`);
  console.log('');

  report('raw cosine', raw, blockSize);
  report('AS-normed', normalized, blockSize);

  const calibration = fitCalibration(normalized);
  console.log('');
  console.log('  Calibrated on the normalized scores, so a threshold can be argued about:');
  for (const score of [-1, 0, 1, 2, 3, 4]) {
    console.log(
      `    normalized ${String(score).padStart(2)}  ->  ` +
        `${(calibratedProbability(score, calibration) * 100).toFixed(1)}% genuine`,
    );
  }
  console.log('');
  console.log('  Pick the operating point from the cost of each mistake: merging two');
  console.log('  people is far worse than leaving one unnamed, and there is no split.');
  console.log('');
}

main();

/**
 * Producing the real file, for whoever has a machine with the sidecar:
 *
 *   1. Record 15-20 minutes in the room this is actually for. Several people,
 *      deliberate overlap, and at least two people appearing in two recordings
 *      made days apart — cross-session identity is the claim, so it has to be
 *      what is measured.
 *   2. Cut it into per-speaker segments and label them.
 *   3. POST each segment to the sidecar's /embed and collect
 *      `[{ "speaker": "...", "embedding": [...] }, ...]`.
 *   4. Run this with --embeddings.
 *
 * Until step 4 has been run, every absolute number about attribution in this
 * repository is about macOS system voices.
 */
