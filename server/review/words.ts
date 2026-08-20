/**
 * Word timings for a line, so a split can be cut where the words actually are.
 *
 * A split has to produce a timestamp or it is not ground truth: landmarks, the
 * span reference and every eval here are time-based, and a character offset
 * into a string carries no time. Whisper gives real per-word start and end, and
 * `readTimedTranscript` is the one reader that also restores punctuation — which
 * is what makes sentence-boundary suggestions possible at all.
 *
 * The true boundary between two speakers is not a point. It is somewhere in the
 * silence between the last word of one part and the first word of the next, and
 * nothing in the recording says where. So a cut is stored as that interval, not
 * as an instant, and the eval scores a system boundary as correct if it lands
 * anywhere inside it. Collapsing the gap to a point would invent a precision
 * the audio does not contain.
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readTimedTranscript, type WhisperResponse } from '../audio/whisper-client';
import { readFileSync } from 'node:fs';
import { audioSearchDirs, isSafeConversationId } from './audio-source';

export interface TimedWord {
  text: string;
  start_ms: number;
  end_ms: number;
}

export interface WordGap {
  /** Index of the word after the gap: a cut here puts words[0..index-1] in the earlier part. */
  index: number;
  /** The cut is anywhere in here. The audio does not say where. */
  from_ms: number;
  to_ms: number;
  /** The preceding word ends a sentence, so this is a natural place to cut. */
  sentence_end: boolean;
}

const cache = new Map<string, { words: TimedWord[]; mtimeMs: number }>();

export function findConversationWords(conversationId: string): string | null {
  if (!isSafeConversationId(conversationId)) return null;
  for (const dir of audioSearchDirs()) {
    const candidate = join(dir, `${conversationId}.whisper.json`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Every word of the recording, cached against the file's mtime. */
export function readConversationWords(conversationId: string): TimedWord[] | null {
  const path = findConversationWords(conversationId);
  if (!path) return null;
  const { mtimeMs } = statSync(path);
  const hit = cache.get(path);
  if (hit && hit.mtimeMs === mtimeMs) return hit.words;
  const payload = JSON.parse(readFileSync(path, 'utf8')) as WhisperResponse;
  const words = readTimedTranscript(payload).words;
  cache.set(path, { words, mtimeMs });
  return words;
}

/**
 * The words of one line.
 *
 * Inclusive of any word that overlaps the line at all, rather than only words
 * wholly inside it: a line boundary that clips a word by a few milliseconds
 * would otherwise drop that word out of the splitter entirely and the owner
 * would be offered a cut list that does not match what he is reading.
 */
export function wordsForLine(conversationId: string, startMs: number, endMs: number): TimedWord[] | null {
  const all = readConversationWords(conversationId);
  if (!all) return null;
  return all.filter((word) => word.end_ms > startMs && word.start_ms < endMs);
}

const SENTENCE_END = /[.!?]["')\]]?$/;

/** The places a cut can go: between consecutive words, never inside one. */
export function gapsBetween(words: TimedWord[]): WordGap[] {
  const gaps: WordGap[] = [];
  for (let index = 1; index < words.length; index += 1) {
    gaps.push({
      index,
      from_ms: words[index - 1].end_ms,
      to_ms: words[index].start_ms,
      sentence_end: SENTENCE_END.test(words[index - 1].text),
    });
  }
  return gaps;
}
