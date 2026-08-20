/**
 * Same-or-different questions: the highest-value thing the page can ask.
 *
 * Correcting a line buys one line. Answering "is 0:E the same person as 950:E?"
 * buys 457 seconds, because it resolves whether a 457-second cluster is one
 * person or two — and the ground-truth builder has already worked out which
 * questions those are and what each is worth. Three of eight diarizer labels
 * carry no landmark at all and hold 65% of all speech; these questions are the
 * cheapest route into that dark.
 *
 * How the questions are actually recorded, which is not what it looks like:
 * `to_resolve[].listen_to` holds clips from the FIRST label only — the builder
 * takes the three longest segments of `label` and writes `s['start']` as `at`.
 * The rival side has no clips at all. Comparing them requires picking the other
 * side's audio here, and getting that wrong would have him compare a voice
 * against itself and answer "same" about two people. The `at` values also do
 * not identify their own label by containment, because segments overlap: only
 * an exact start match does.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

export interface QuestionClip {
  start_ms: number;
  end_ms: number;
  text: string;
  label: string;
}

export interface IdentityQuestion {
  id: string;
  recording: string;
  label_a: string;
  label_b: string;
  question: string;
  worth_seconds: number;
  co_assignment: number | null;
  clips_a: QuestionClip[];
  clips_b: QuestionClip[];
}

interface GroundTruth {
  recording: string;
  spans: { start_ms: number; end_ms: number; label: string; speaker?: string }[];
  excluded: { start_ms: number; end_ms: number; label: string }[];
  to_resolve: {
    question: string;
    worth_seconds: number;
    listen_to: { at: number; text: string }[];
    rivals: { with: string; co_assignment?: number }[];
  }[];
}

/** How close an `at` has to be to a span's start to be that span. */
const START_TOLERANCE_MS = 60;
const CLIPS_PER_SIDE = 3;

export function groundTruthPath(recording: string): string {
  // Only dorm-40min has a builder output today; the path is per-recording so a
  // second one does not silently read the first one's questions.
  const named = resolve(repoRoot, 'eval', 'real', `${recording}.ground-truth.json`);
  return existsSync(named) ? named : resolve(repoRoot, 'eval', 'real', 'ground-truth.json');
}

function readGroundTruth(recording: string): GroundTruth | null {
  const path = groundTruthPath(recording);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as GroundTruth;
    // `recording` in the file is a filename ("dorm-40min.wav").
    if (parsed.recording && !parsed.recording.startsWith(recording)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function longestSpansFor(truth: GroundTruth, label: string, count: number): QuestionClip[] {
  return [...truth.spans, ...truth.excluded]
    .filter((span) => span.label === label)
    .sort((a, b) => (b.end_ms - b.start_ms) - (a.end_ms - a.start_ms))
    .slice(0, count)
    .map((span) => ({ start_ms: span.start_ms, end_ms: span.end_ms, text: '', label }));
}

/**
 * Resolve a `listen_to` entry to the span it came from.
 *
 * By exact start, never by containment: segments overlap heavily in the
 * impure stretches, and a containment lookup on these three clips returns
 * labels 0:A and 0:G for a question about 0:E.
 */
function clipAt(truth: GroundTruth, atSeconds: number, label: string, text: string): QuestionClip | null {
  const ms = Math.round(atSeconds * 1000);
  const match = [...truth.spans, ...truth.excluded]
    .filter((span) => span.label === label && Math.abs(span.start_ms - ms) <= START_TOLERANCE_MS)
    .sort((a, b) => (b.end_ms - b.start_ms) - (a.end_ms - a.start_ms))[0];
  if (!match) return null;
  return { start_ms: match.start_ms, end_ms: match.end_ms, text, label };
}

export function openQuestions(recording: string): IdentityQuestion[] {
  const truth = readGroundTruth(recording);
  if (!truth) return [];

  const questions: IdentityQuestion[] = [];
  for (const row of truth.to_resolve ?? []) {
    const labelA = row.question.split(' ')[1];
    const rival = row.rivals?.[0];
    if (!labelA || !rival?.with) continue;

    const clipsA = row.listen_to
      .map((clip) => clipAt(truth, clip.at, labelA, clip.text))
      .filter((clip): clip is QuestionClip => clip !== null);
    const clipsB = longestSpansFor(truth, rival.with, CLIPS_PER_SIDE);
    // A question he cannot listen to both sides of is not answerable, and
    // showing it would invite a guess about audio he never heard.
    if (clipsA.length === 0 || clipsB.length === 0) continue;

    questions.push({
      id: `${recording}:${labelA}:${rival.with}`,
      recording,
      label_a: labelA,
      label_b: rival.with,
      question: row.question,
      worth_seconds: row.worth_seconds,
      co_assignment: rival.co_assignment ?? null,
      clips_a: clipsA,
      clips_b: clipsB,
    });
  }
  return questions.sort((a, b) => b.worth_seconds - a.worth_seconds);
}
