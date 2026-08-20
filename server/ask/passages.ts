/**
 * Passages: the unit retrieval reduces a long conversation to.
 *
 * A single turn is too small to be about anything — "yeah", "for sure", a name
 * on its own — and a whole conversation is far too large to put in a prompt. A
 * 48-minute recording arrives as 2,772 turns and 11,925 words; grouping those
 * into contiguous, speaker-attributed windows gives 95 units that can each be
 * scored, sampled and quoted.
 *
 * Everything here is pure: turns in, ordered passages out. No storage, no
 * model, no network, so the reduction can be tested on a real transcript
 * without either.
 */

import { tokenize } from './scoring';

export interface PassageUtterance {
  id: string;
  person_id?: string;
  text: string;
  start_ms: number;
  end_ms: number;
}

export interface Passage {
  id: string;
  conversation_id: string;
  index: number;
  start_ms: number;
  end_ms: number;
  utterances: PassageUtterance[];
  /** Distinct speakers, in order of first appearance within the passage. */
  speaker_ids: Array<string | undefined>;
  text: string;
  word_count: number;
}

/**
 * Words per passage.
 *
 * Measured on the 48-minute fixture, conversation runs at 247 words per minute
 * of elapsed time (282 per minute of actual speech — seven people in a small
 * room barely leave gaps). So 120 words is roughly half a minute of talk: long
 * enough to hold a complete exchange, a question and its answer, and short
 * enough that it is usually about one thing.
 *
 * Half a minute is the target, not the arithmetic. A calmer conversation runs
 * far slower and the same 120 words will span longer; that is the intended
 * behaviour, since the unit is meant to be "about one thing" rather than a
 * fixed duration.
 */
export const PASSAGE_TARGET_WORDS = 120;

/** A passage never grows past this, even if nobody pauses and nobody yields. */
const PASSAGE_MAX_WORDS = 280;

/**
 * Silence that counts as a seam.
 *
 * Conversations change subject across a pause far more often than mid-breath.
 *
 * Be clear about how little this does on a crowded recording: on the 48-minute
 * fixture the median inter-turn gap is 0 ms and the 90th percentile is 372 ms,
 * and only 9 gaps in the whole conversation reach four seconds — 0.3% of turn
 * boundaries. Essentially every seam there comes from a speaker change instead.
 *
 * It is kept because the sparse case is real and is the case it was written
 * for: two people in a quiet room, thinking between topics. It should not be
 * lowered to make it fire more often here, because a pause in seven-way
 * crosstalk means somebody drew breath, not that the subject changed.
 */
const TOPIC_BREAK_SILENCE_MS = 4_000;

function wordCount(text: string): number {
  return text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length;
}

function makePassage(conversationId: string, index: number, utterances: PassageUtterance[]): Passage {
  const speakers: Array<string | undefined> = [];
  for (const utterance of utterances) {
    if (!speakers.includes(utterance.person_id)) speakers.push(utterance.person_id);
  }
  const text = utterances.map((utterance) => utterance.text.trim()).join(' ');
  return {
    id: `${conversationId}#${index}`,
    conversation_id: conversationId,
    index,
    start_ms: utterances[0].start_ms,
    end_ms: utterances[utterances.length - 1].end_ms,
    utterances,
    speaker_ids: speakers,
    text,
    word_count: wordCount(text),
  };
}

/**
 * Group turns into passages, cutting at natural seams.
 *
 * A cut is only considered once the passage has reached its target size, and
 * only where the conversation itself offers a break: the speaker changes, or
 * there is a real silence. Cutting purely on a word count would routinely slice
 * a question away from its answer, which is the one thing a passage exists to
 * keep together.
 */
export function buildPassages(conversationId: string, utterances: PassageUtterance[]): Passage[] {
  const ordered = [...utterances].sort((a, b) => a.start_ms - b.start_ms || a.id.localeCompare(b.id));
  const passages: Passage[] = [];
  let current: PassageUtterance[] = [];
  let words = 0;

  const flush = () => {
    if (current.length === 0) return;
    passages.push(makePassage(conversationId, passages.length, current));
    current = [];
    words = 0;
  };

  ordered.forEach((utterance, position) => {
    current.push(utterance);
    words += wordCount(utterance.text);

    const next = ordered[position + 1];
    if (!next) return;

    const atSeam =
      next.person_id !== utterance.person_id || next.start_ms - utterance.end_ms >= TOPIC_BREAK_SILENCE_MS;
    if (words >= PASSAGE_MAX_WORDS || (words >= PASSAGE_TARGET_WORDS && atSeam)) flush();
  });

  flush();
  return passages;
}

export interface PassageIndex {
  passages: Passage[];
  /** Inverse passage frequency: how much a term distinguishes one passage from the rest. */
  idf: Map<string, number>;
}

export function indexPassages(passages: Passage[]): PassageIndex {
  const containing = new Map<string, number>();
  for (const passage of passages) {
    for (const term of new Set(tokenize(passage.text))) {
      containing.set(term, (containing.get(term) ?? 0) + 1);
    }
  }
  const idf = new Map<string, number>();
  for (const [term, count] of containing) {
    idf.set(term, Math.log(1 + passages.length / count));
  }
  return { passages, idf };
}

function termScore(text: string, index: PassageIndex): number {
  let total = 0;
  for (const term of new Set(tokenize(text))) total += index.idf.get(term) ?? 0;
  return total;
}

/**
 * The handful of words that make this stretch of talk different from the rest
 * of the same conversation. Cheap, deterministic topic labels — no model, so
 * nothing here can be invented.
 */
export function distinctiveTerms(passage: Passage, index: PassageIndex, limit = 5): string[] {
  const counts = new Map<string, number>();
  for (const term of tokenize(passage.text)) counts.set(term, (counts.get(term) ?? 0) + 1);

  return [...counts.entries()]
    .map(([term, count]) => ({ term, weight: (index.idf.get(term) ?? 0) * Math.log(1 + count) }))
    .filter((entry) => entry.weight > 0 && entry.term.length > 2)
    .sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term))
    .slice(0, limit)
    .map((entry) => entry.term);
}

/**
 * How much this passage carries, independent of any question.
 *
 * Total rarity of its distinct vocabulary, damped by length. A minute of
 * "yeah", "mhm", "for sure" has almost no distinct vocabulary and what it has
 * turns up everywhere, so it scores near zero however long it runs; a stretch
 * where somebody explains their degree brings dozens of words that appear
 * nowhere else, so it scores high.
 *
 * Mean rarity per term was the obvious alternative and is wrong: a passage that
 * repeats two rare words a hundred times scores the same as one that uses fifty
 * of them once. The square root keeps a long passage from winning on bulk while
 * still crediting it for saying more.
 */
export function informationScore(passage: Passage, index: PassageIndex): number {
  if (passage.word_count === 0) return 0;
  let total = 0;
  for (const term of new Set(tokenize(passage.text))) total += index.idf.get(term) ?? 0;
  return total / Math.sqrt(passage.word_count);
}

export interface CoverageRequest {
  /** How many passages to come back with. */
  slots: number;
  /** Optional per-passage relevance, 0-1, when the question points somewhere. */
  focus?: Map<string, number>;
  /** How hard focus pulls against even coverage. */
  focusWeight?: number;
}

function normalize(scores: Map<string, number>): Map<string, number> {
  const highest = Math.max(0, ...scores.values());
  if (highest === 0) return new Map();
  return new Map([...scores].map(([id, score]) => [id, score / highest]));
}

/**
 * Choose passages that represent the whole scope rather than the top of one
 * cluster.
 *
 * Plain top-N by relevance is what makes long-conversation retrieval feel
 * broken: ten hits from the same four minutes, and forty minutes the answer
 * never sees. So the timeline is cut into as many equal spans as there are
 * slots and the best passage in each span is taken. Every part of the
 * conversation is represented; focus decides *which* passage within a span, not
 * whether a span appears at all.
 */
export function selectRepresentative(index: PassageIndex, request: CoverageRequest): Passage[] {
  const { passages } = index;
  const slots = Math.max(1, Math.floor(request.slots));
  if (passages.length <= slots) return [...passages];

  const information = normalize(new Map(passages.map((passage) => [passage.id, informationScore(passage, index)])));
  const focus = normalize(request.focus ?? new Map());
  const focusWeight = request.focusWeight ?? 2;

  const score = (passage: Passage) =>
    (information.get(passage.id) ?? 0) + focusWeight * (focus.get(passage.id) ?? 0);

  const chosen: Passage[] = [];
  for (let slot = 0; slot < slots; slot += 1) {
    const from = Math.floor((slot * passages.length) / slots);
    const to = Math.floor(((slot + 1) * passages.length) / slots);
    const span = passages.slice(from, Math.max(to, from + 1));
    const best = span.reduce((winner, passage) => (score(passage) > score(winner) ? passage : winner), span[0]);
    if (best) chosen.push(best);
  }
  return chosen;
}

/**
 * The lines inside a passage worth quoting, in the order they were said.
 *
 * Ranked by how much rare vocabulary each turn carries, so backchannels fall
 * away and the sentence that actually says something survives — then put back
 * in chronological order, because a reply quoted before its question reads as a
 * different conversation.
 */
export function representativeUtterances(
  passage: Passage,
  index: PassageIndex,
  maxWords: number,
): PassageUtterance[] {
  if (passage.utterances.length === 0) return [];

  const ranked = [...passage.utterances]
    .map((utterance) => ({ utterance, score: termScore(utterance.text, index) }))
    .sort((a, b) => b.score - a.score);

  const kept: PassageUtterance[] = [];
  let words = 0;
  for (const { utterance } of ranked) {
    const size = wordCount(utterance.text);
    if (kept.length > 0 && words + size > maxWords) continue;
    kept.push(utterance);
    words += size;
    if (words >= maxWords) break;
  }

  return kept.sort((a, b) => a.start_ms - b.start_ms);
}

/**
 * Fold a long timeline into a fixed number of buckets so a topic strip stays a
 * constant size whether the recording ran ten minutes or four hours.
 */
export function bucketPassages(passages: Passage[], buckets: number): Passage[][] {
  if (passages.length <= buckets) return passages.map((passage) => [passage]);
  const grouped: Passage[][] = [];
  for (let bucket = 0; bucket < buckets; bucket += 1) {
    const from = Math.floor((bucket * passages.length) / buckets);
    const to = Math.floor(((bucket + 1) * passages.length) / buckets);
    grouped.push(passages.slice(from, Math.max(to, from + 1)));
  }
  return grouped;
}
