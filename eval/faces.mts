/**
 * Measure the face thresholds instead of guessing them.
 *
 *   bun run eval:faces fixtures/glasses/enroll
 *   bun run eval:faces -- --voice
 *
 * FACE_MATCH_THRESHOLD, FACE_MATCH_MARGIN and FACE_CALIBRATION currently carry
 * placeholder values with a note in shared/contracts.ts saying so. This is the
 * thing that removes the note: it embeds every crop through the sidecar,
 * scores every pair, and prints the constants back as source lines to paste.
 *
 * Input layout, all of it gitignored because a face crop is personal data:
 *
 *   fixtures/glasses/enroll/<person>/*.jpg   several crops of one person
 *   fixtures/glasses/enroll/strangers/*.jpg  one crop each of people seen once
 *
 * Every strangers/ image is its own identity, so it contributes impostor pairs
 * and no genuine ones — which is what a stranger is.
 *
 * `--voice` does the same arithmetic for VOICE_CALIBRATION over the ECAPA
 * embeddings in fixtures/real/cross-session.json, so the two identifiers are
 * calibrated the same way and their probabilities can honestly be multiplied.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  FACE_MATCH_MARGIN,
  FACE_MATCH_THRESHOLD,
  FACEPRINT_DIMS,
} from '../shared/contracts';
import {
  equalErrorRate,
  errorRatesAt,
  fitCalibration,
  type Calibration,
  type Trial,
} from '../server/identity/score-norm';

const DEFAULT_ENROLL_DIR = 'fixtures/glasses/enroll';
const STRANGERS = 'strangers';
const CROSS_SESSION = 'fixtures/real/cross-session.json';
/** Merging two people is far worse than leaving one unnamed, so aim low. */
const TARGET_FALSE_ACCEPT_RATE = 0.001;
const CANDIDATE_THRESHOLDS = [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7];

interface Options {
  dir: string;
  sidecarUrl: string;
  voice: boolean;
}

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function parseOptions(args: string[]): Options {
  const positional = args.filter((arg) => !arg.startsWith('--'));
  const flagged = new Set(args.flatMap((arg, index) => (arg.startsWith('--') ? [args[index + 1] ?? ''] : [])));
  return {
    dir: resolve(positional.find((arg) => !flagged.has(arg)) ?? DEFAULT_ENROLL_DIR),
    sidecarUrl: readOption(args, 'sidecar-url') ?? process.env.SIDECAR_URL ?? 'http://127.0.0.1:8099',
    voice: args.includes('--voice'),
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

interface Sample {
  label: string;
  file: string;
  vector: number[];
}

function imagesIn(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => /\.(jpe?g|png)$/i.test(name))
    .sort()
    .map((name) => join(dir, name));
}

interface LabelledFile {
  label: string;
  file: string;
}

/** Each strangers/ image is its own person; every other directory is one. */
function collectFiles(dir: string): LabelledFile[] {
  const entries = readdirSync(dir).filter((name) => statSync(join(dir, name)).isDirectory());
  const files: LabelledFile[] = [];
  for (const entry of entries.sort()) {
    const images = imagesIn(join(dir, entry));
    for (const file of images) {
      files.push({ label: entry === STRANGERS ? `stranger:${file}` : entry, file });
    }
  }
  return files;
}

async function embedCrop(sidecarUrl: string, file: string): Promise<number[] | string> {
  const response = await fetch(`${sidecarUrl}/face/embed`, {
    method: 'POST',
    headers: { 'content-type': 'image/jpeg' },
    body: readFileSync(file),
  });
  if (!response.ok) return `${response.status} ${(await response.text()).slice(0, 80)}`;
  const body = (await response.json()) as { vector: number[]; dims: number };
  if (body.dims !== FACEPRINT_DIMS) return `sidecar returned ${body.dims} dims, expected ${FACEPRINT_DIMS}`;
  return body.vector;
}

async function embedAll(options: Options, files: LabelledFile[]): Promise<Sample[]> {
  const samples: Sample[] = [];
  for (const entry of files) {
    const vector = await embedCrop(options.sidecarUrl, entry.file);
    if (typeof vector === 'string') {
      console.log(`  skipped ${entry.file}: ${vector}`);
      continue;
    }
    samples.push({ label: entry.label, file: entry.file, vector });
  }
  return samples;
}

function allPairs(samples: Sample[]): Trial[] {
  const trials: Trial[] = [];
  for (let left = 0; left < samples.length; left += 1) {
    for (let right = left + 1; right < samples.length; right += 1) {
      const a = samples[left] as Sample;
      const b = samples[right] as Sample;
      trials.push({ score: cosine(a.vector, b.vector), genuine: a.label === b.label });
    }
  }
  return trials;
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] as number;
}

/**
 * How far the best candidate must beat the runner-up.
 *
 * Measured on the impostors alone: two people the matcher confuses can sit any
 * distance apart by luck, and the margin has to be wider than that luck
 * usually is. So take the gap between the two highest impostor scores each
 * probe sees, and ask for more than nineteen out of twenty of them.
 */
function recommendedMargin(samples: Sample[]): number {
  const gaps: number[] = [];
  for (const probe of samples) {
    const impostorScores = samples
      .filter((other) => other !== probe && other.label !== probe.label)
      .map((other) => cosine(probe.vector, other.vector))
      .sort((a, b) => b - a);
    if (impostorScores.length >= 2) {
      gaps.push((impostorScores[0] as number) - (impostorScores[1] as number));
    }
  }
  return gaps.length === 0 ? FACE_MATCH_MARGIN : Number(percentile(gaps, 0.95).toFixed(3));
}

/** The lowest threshold that holds false accepts under target, else the EER point. */
function recommendedThreshold(trials: Trial[], eerThreshold: number): { value: number; basis: string } {
  const candidates = [...new Set(trials.map((trial) => trial.score))].sort((a, b) => a - b);
  for (const candidate of candidates) {
    if (errorRatesAt(trials, candidate).falseAcceptRate <= TARGET_FALSE_ACCEPT_RATE) {
      return { value: Number(candidate.toFixed(3)), basis: `FAR <= ${TARGET_FALSE_ACCEPT_RATE}` };
    }
  }
  return { value: Number(eerThreshold.toFixed(3)), basis: 'equal error rate' };
}

/** Pinned so the accept rule and the probability cross zero at the same score. */
function anchoredCalibration(fitted: Calibration, threshold: number): Calibration {
  const slope = Number(fitted.slope.toFixed(1));
  return { slope, intercept: Number((-slope * threshold).toFixed(2)) };
}

function printErrorTable(trials: Trial[]): void {
  console.log('\nthreshold   FAR      FRR');
  for (const threshold of CANDIDATE_THRESHOLDS) {
    const { falseAcceptRate, falseRejectRate } = errorRatesAt(trials, threshold);
    console.log(
      `  ${threshold.toFixed(2)}      ${(falseAcceptRate * 100).toFixed(2)}%   ${(falseRejectRate * 100).toFixed(2)}%`,
    );
  }
}

function summarise(trials: Trial[]): { genuine: number[]; impostor: number[] } {
  return {
    genuine: trials.filter((trial) => trial.genuine).map((trial) => trial.score),
    impostor: trials.filter((trial) => !trial.genuine).map((trial) => trial.score),
  };
}

function describeDistributions(trials: Trial[]): void {
  const { genuine, impostor } = summarise(trials);
  const mean = (values: number[]) =>
    values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
  console.log(`genuine pairs   ${genuine.length}, mean ${mean(genuine).toFixed(3)}, 5th pct ${percentile(genuine, 0.05).toFixed(3)}`);
  console.log(`impostor pairs  ${impostor.length}, mean ${mean(impostor).toFixed(3)}, 95th pct ${percentile(impostor, 0.95).toFixed(3)}`);
  console.log(`max impostor    ${impostor.length === 0 ? 'n/a' : Math.max(...impostor).toFixed(3)}`);
}

async function runFaces(options: Options): Promise<number> {
  if (!existsSync(options.dir)) {
    console.error(`no enroll set at ${options.dir}.`);
    console.error(`Put a few crops per person in ${DEFAULT_ENROLL_DIR}/<person>/ and singles in ${STRANGERS}/.`);
    return 2;
  }
  const files = collectFiles(options.dir);
  console.log(`enroll set  ${options.dir}`);
  console.log(`            ${files.length} images, ${new Set(files.map((file) => file.label)).size} identities`);
  console.log(`sidecar     ${options.sidecarUrl}\n`);

  const samples = await embedAll(options, files);
  if (samples.length < 2) {
    console.error(`\nonly ${samples.length} crops embedded; nothing to measure.`);
    return 1;
  }

  const trials = allPairs(samples);
  describeDistributions(trials);
  const { eer, threshold } = equalErrorRate(trials);
  console.log(`EER             ${(eer * 100).toFixed(2)}% at ${threshold.toFixed(3)}`);
  printErrorTable(trials);

  const fitted = fitCalibration(trials);
  console.log(`\nfitCalibration  slope ${fitted.slope.toFixed(3)}, intercept ${fitted.intercept.toFixed(3)}`);

  const recommended = recommendedThreshold(trials, threshold);
  const margin = recommendedMargin(samples);
  const calibration = anchoredCalibration(fitted, recommended.value);
  console.log(`\nPaste into shared/contracts.ts (threshold basis: ${recommended.basis}):\n`);
  console.log(`export const FACE_MATCH_THRESHOLD = ${recommended.value};`);
  console.log(`export const FACE_MATCH_MARGIN = ${margin};`);
  console.log(
    `export const FACE_CALIBRATION: Calibration = { slope: ${calibration.slope}, intercept: ${calibration.intercept} };`,
  );
  console.log(`\n(currently ${FACE_MATCH_THRESHOLD} / ${FACE_MATCH_MARGIN}, both placeholders.)`);
  return 0;
}

interface SessionFixture {
  session_mean: number[];
  speakers: Record<string, { embedding: number[]; duration_ms: number }>;
}

/**
 * The voice half, from the fixture the cross-session test already uses.
 *
 * Every enrolled speaker against every tested speaker: genuine when the two
 * names agree. It is a small corpus and it is one recording, so the slope it
 * fits is a sanity check on the derivation in contracts rather than a
 * replacement for it.
 */
function runVoice(): number {
  const path = resolve(CROSS_SESSION);
  if (!existsSync(path)) {
    console.log(`no ${CROSS_SESSION}: it is gitignored personal data, regenerate it with eval/real/export_sessions.py.`);
    return 0;
  }
  const fixture = JSON.parse(readFileSync(path, 'utf8')) as { enroll: SessionFixture; test: SessionFixture };
  const trials: Trial[] = [];
  for (const [enrolled, left] of Object.entries(fixture.enroll.speakers)) {
    for (const [tested, right] of Object.entries(fixture.test.speakers)) {
      trials.push({ score: cosine(left.embedding, right.embedding), genuine: enrolled === tested });
    }
  }
  console.log(`voice trials    ${trials.length} from ${CROSS_SESSION}`);
  describeDistributions(trials);
  const { eer, threshold } = equalErrorRate(trials);
  console.log(`EER             ${(eer * 100).toFixed(2)}% at ${threshold.toFixed(3)}`);
  const fitted = fitCalibration(trials);
  const calibration = anchoredCalibration(fitted, threshold);
  console.log(`\nfitCalibration  slope ${fitted.slope.toFixed(3)}, intercept ${fitted.intercept.toFixed(3)}`);
  console.log('\nPaste into shared/contracts.ts:\n');
  console.log(
    `export const VOICE_CALIBRATION: Calibration = { slope: ${calibration.slope}, intercept: ${calibration.intercept} };`,
  );
  return 0;
}

const options = parseOptions(process.argv.slice(2));
process.exit(options.voice ? runVoice() : await runFaces(options));
