import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { joinTranscriptToTurns, type AttributionRun } from '../server/audio/attribute-recording';
import type { SpeakerTurn } from '../server/audio/diarize-sidecar';
import { readTimedTranscript, type WhisperResponse } from '../server/audio/whisper-client';
import { dropSilentRepeats } from '../server/audio/loop-repair';

/**
 * Access to the real recorded conversation used for calibration.
 *
 * `fixtures/real/` is gitignored on purpose: it is an actual conversation
 * between real people, two of whom are not contributors here, and the audio,
 * the transcript and the ECAPA embeddings are all personal data. Tests that
 * depend on it therefore have to cope with it being absent on a fresh clone —
 * and they must say why they skipped, because a silently skipped test is worse
 * than a failing one.
 */

const here = dirname(fileURLToPath(import.meta.url));

export function realFixturePath(name: string): string {
  return join(here, 'real', name);
}

/**
 * Set `AMELIA_REQUIRE_FIXTURES=1` to turn "skipped" into "failed".
 *
 * Skipping is right on a fresh clone and wrong when you believe you are
 * validating something. `eval/cross-session.test.ts` calls itself the
 * acceptance test for the whole product; without this it reports green while
 * running nothing, which is the most expensive kind of passing test. Anyone
 * checking a real change should run the suite with this set.
 */
export function fixturesRequired(): boolean {
  return process.env.AMELIA_REQUIRE_FIXTURES === '1';
}

export function hasRealFixture(name: string): boolean {
  const present = existsSync(realFixturePath(name));
  if (!present && fixturesRequired()) {
    throw new Error(
      `AMELIA_REQUIRE_FIXTURES=1 but fixtures/real/${name} is missing, so the suite ` +
        `that needs it would have skipped silently. ${missingFixtureNotice(name)}`,
    );
  }
  return present;
}

export function readRealFixture<T>(name: string): T {
  return JSON.parse(readFileSync(realFixturePath(name), 'utf8')) as T;
}

/**
 * Why a suite is being skipped, phrased so somebody who has never seen this
 * repository knows what to do about it.
 */
export function missingFixtureNotice(name: string): string {
  return (
    `skipped: fixtures/real/${name} is absent. It is deliberately not committed ` +
    `(a real conversation between real people). Regenerate the derived fixtures ` +
    `from your own recording with the scripts in eval/real/.`
  );
}

/**
 * The two fixtures the product actually reads for a recording.
 *
 * `{stem}.merged.json` is the retired realtime provider's output and is not one
 * of them. Anything asserting product behaviour has to start here instead, or
 * it is measuring a transcript nothing produces any more.
 */
export function realRecordingFixtures(stem: string): [whisper: string, pyannote: string] {
  // Prefer the sentence-corrected turns. `session.ts` runs correctBySentence
  // between diarization and the join, so raw pyannote turns are no longer what
  // the product attributes from — a suite reading them measures a pipeline that
  // was replaced. The naming assertions were doing exactly that, which is how a
  // detection that rested on the old glued lines looked like a real win.
  const corrected = `${stem}.sentpool.json`;
  return [
    `${stem}.whisper.json`,
    hasRealFixture(corrected) ? corrected : `${stem}.pyannote.json`,
  ];
}

export function hasRealRecording(stem: string): boolean {
  return realRecordingFixtures(stem).every((fixture) => hasRealFixture(fixture));
}

export function missingRecordingNotice(stem: string): string {
  const absent = realRecordingFixtures(stem).find((fixture) => !existsSync(realFixturePath(fixture)));
  return missingFixtureNotice(absent ?? `${stem}.whisper.json`);
}

/**
 * A recording turned into attributed lines the way the server does it.
 *
 * One reader, because five suites used to hand-roll this join and every copy
 * drifted: some dropped whisper's segments, which is what decides who owns a
 * word spoken over somebody else, and some mapped `words` directly, which loses
 * the punctuation the naming rules key on. `joinTranscriptToTurns` is the same
 * call `server/audio/session.ts` and `tools/seed-from-recording.mts` make, so a
 * test built on this cannot disagree with the product about what a line is.
 */
export function readRealRecording(stem: string): AttributionRun {
  const [whisper, pyannote] = realRecordingFixtures(stem);
  const transcript = readTimedTranscript(readRealFixture<WhisperResponse>(whisper));
  const turns = readRealFixture<{ turns: SpeakerTurn[] }>(pyannote).turns;
  // `session.ts` drops repetition runs standing over silence between diarization
  // and the join, so a reader that skips it reports a correctly seeded store as
  // stale and hands the review queue six "Thank you." over applause to rule on.
  //
  // The speech map is the RAW diarization, matching what the session passes.
  // The corrected turns above are a rewrite of it, and measuring coverage
  // against a rewrite of itself is not the same question.
  const raw = `${stem}.pyannote.json`;
  const speech = hasRealFixture(raw)
    ? readRealFixture<{ turns: SpeakerTurn[] }>(raw).turns
    : turns;
  const cleaned = dropSilentRepeats(transcript, speech);
  return joinTranscriptToTurns(cleaned.words, turns, 0, cleaned.segments);
}

export interface RealLine {
  id: string;
  speaker: string;
  text: string;
  start_ms: number;
  end_ms: number;
}

/** The attributed lines with an id, which is the shape most callers want. */
export function readRealLines(stem: string): RealLine[] {
  return readRealRecording(stem)
    .segments.filter((segment) => segment.text.trim())
    .map((segment, index) => ({
      id: `${stem}-u${index}`,
      speaker: segment.speaker,
      text: segment.text,
      start_ms: segment.start_ms,
      end_ms: segment.end_ms,
    }));
}
