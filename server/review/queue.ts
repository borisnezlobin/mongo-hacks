/**
 * What is worth reviewing next.
 *
 * The page used to be a list from 00:00, which spends his attention on the
 * opening minutes and never reaches minute thirty. That is the wrong hundred
 * lines: evaluation currently covers 3 of the 7 people in this recording, so a
 * change that shuffles errors among the other four is invisible to every metric
 * we have. A single confirmed line from a voice with no ground truth is worth
 * more than a tenth confirmation on Boris.
 *
 * The axes below were measured on the real recording rather than assumed, and
 * two candidates were dropped for failing that test:
 *
 *  - `overlappedWords > 0` fires on 75% of lines and "spans more than one
 *    pyannote speaker" on 70%. Neither ranks anything; they just say pyannote's
 *    turns overlap everywhere.
 *  - `identity_confidence` is the literal constant 'confirmed' on all 767
 *    stored lines, so it carries no information at all.
 *
 * What survived: speaker deficit, the top-two speaker margin (p10 0.00, p50
 * 0.56, p90 1.00 — genuinely spread), turns under a second (32% of lines, and
 * the failure mode this repository already has evidence for), and timeline
 * spread.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { audioSearchDirs, isSafeConversationId } from './audio-source';

export interface QueueLine {
  id: string;
  at_ms: number;
  end_ms: number;
  person_id: string | null;
}

/**
 * Share of all speech each voice holds.
 *
 * Deficit alone treats a voice with 1075 seconds and one with 40 as equally
 * dark. They are not: three of eight labels carry no landmark and hold 65% of
 * all speech, and the largest of them is the single biggest label in the
 * recording. Weighting by speech held is what puts it first.
 */
export function speechShare(lines: QueueLine[]): Map<string, number> {
  const held = new Map<string, number>();
  let total = 0;
  for (const line of lines) {
    const ms = Math.max(0, line.end_ms - line.at_ms);
    const person = line.person_id ?? 'unknown';
    held.set(person, (held.get(person) ?? 0) + ms);
    total += ms;
  }
  const share = new Map<string, number>();
  for (const [person, ms] of held) share.set(person, total > 0 ? ms / total : 0);
  return share;
}

export interface QueueSignals {
  /** Share of the line held by the leading diarizer speaker, minus the runner-up. */
  margin: number;
  durationMs: number;
}

export interface RankedLine {
  id: string;
  score: number;
  /** Why this line is being asked about, in his terms. */
  reason: string;
}

export interface SpeakerCoverage {
  person_id: string;
  confirmed: number;
  lines: number;
  speaking_ms: number;
  share: number;
  /** Confirmations still wanted before this voice stops being a blind spot. */
  wanted: number;
}

/**
 * Three confirmations per voice.
 *
 * One is enough to place a voice in the landmark set at all, which is what
 * catches a merge. Three buys redundancy against a single mis-click becoming
 * the only evidence about a person, without pretending we need dozens.
 */
export const TARGET_PER_SPEAKER = 3;
const TIMELINE_BUCKETS = 12;
const SHORT_TURN_MS = 1_000;

const WEIGHT = { speaker: 3.0, uncertainty: 1.5, shortTurn: 0.8, timeline: 1.0 };

/**
 * A line long enough to recognise a stranger's voice from.
 *
 * Below this you can verify a speaker you already know; you cannot learn one.
 */
const IDENTIFIABLE_MS = 2_000;

interface Turn {
  start_ms: number;
  end_ms: number;
  speaker: string;
}

const turnCache = new Map<string, Turn[] | null>();

function turnsFor(conversationId: string): Turn[] | null {
  if (!isSafeConversationId(conversationId)) return null;
  if (turnCache.has(conversationId)) return turnCache.get(conversationId)!;
  let turns: Turn[] | null = null;
  for (const dir of audioSearchDirs()) {
    const path = join(dir, `${conversationId}.pyannote.json`);
    if (!existsSync(path)) continue;
    try {
      turns = (JSON.parse(readFileSync(path, 'utf8')) as { turns: Turn[] }).turns;
    } catch {
      turns = null;
    }
    break;
  }
  turnCache.set(conversationId, turns);
  return turns;
}

/**
 * How cleanly the diarizer owns this span.
 *
 * 1 means one speaker holds the line outright; 0 means two hold equal shares
 * and the label on it is a coin toss. Without turns to compare against every
 * line scores 1, which makes the queue fall back to speaker deficit and
 * timeline spread rather than inventing an uncertainty it cannot measure.
 */
export function signalsFor(conversationId: string, line: QueueLine): QueueSignals {
  const durationMs = Math.max(0, line.end_ms - line.at_ms);
  const turns = turnsFor(conversationId);
  if (!turns) return { margin: 1, durationMs };

  const share = new Map<string, number>();
  for (const turn of turns) {
    const overlap = Math.min(turn.end_ms, line.end_ms) - Math.max(turn.start_ms, line.at_ms);
    if (overlap > 0) share.set(turn.speaker, (share.get(turn.speaker) ?? 0) + overlap);
  }
  const held = [...share.values()].sort((a, b) => b - a);
  if (held.length < 2) return { margin: 1, durationMs };
  const total = held.reduce((sum, ms) => sum + ms, 0) || 1;
  return { margin: (held[0] - held[1]) / total, durationMs };
}

function bucketOf(line: QueueLine, durationMs: number): number {
  if (durationMs <= 0) return 0;
  return Math.min(TIMELINE_BUCKETS - 1, Math.floor((line.at_ms / durationMs) * TIMELINE_BUCKETS));
}

/**
 * Order the unreviewed lines by what his next confirmation would buy.
 *
 * Greedy with the counters updated as each line is placed, rather than a single
 * static sort. That is what keeps the queue interleaved: confirming one line
 * from a silent voice halves that voice's deficit, so the next pick moves on
 * instead of handing him two hundred consecutive lines of the same person. It
 * also makes the ordering deterministic and computable in one pass, so the page
 * does not have to re-ask the server after every save.
 */
export function rankLines(
  conversationId: string,
  lines: QueueLine[],
  reviewed: Set<string>,
  confirmedBySpeaker: Map<string, number>,
): RankedLine[] {
  const recordingMs = lines.reduce((max, line) => Math.max(max, line.end_ms), 0);
  const speakerCount = new Map(confirmedBySpeaker);
  const share = speechShare(lines);
  const bucketCount = new Map<number, number>();
  const signals = new Map<string, QueueSignals>();

  const pending: QueueLine[] = [];
  for (const line of lines) {
    signals.set(line.id, signalsFor(conversationId, line));
    if (reviewed.has(line.id)) {
      const bucket = bucketOf(line, recordingMs);
      bucketCount.set(bucket, (bucketCount.get(bucket) ?? 0) + 1);
      continue;
    }
    pending.push(line);
  }

  const ranked: RankedLine[] = [];
  const remaining = new Set(pending.map((line) => line.id));
  const byId = new Map(pending.map((line) => [line.id, line]));

  while (remaining.size > 0) {
    let best: { line: QueueLine; score: number; parts: Record<string, number> } | null = null;
    for (const id of remaining) {
      const line = byId.get(id)!;
      const signal = signals.get(id)!;
      const person = line.person_id ?? 'unknown';
      // Two phases, because the best line for a voice depends on whether we
      // have ever heard it named.
      //
      // A voice with no ground truth needs a line he can actually identify: a
      // long, clean turn. Ranking such a voice by ambiguity offered a 300ms
      // "yeah." as the first anchor for the largest unlabelled speaker in the
      // recording, which he could not confidently attribute and which would
      // have become ground truth anyway.
      //
      // Once a voice has been pinned once, the valuable lines invert: short and
      // contested turns are where attribution actually fails, so that is where
      // his next confirmation is worth most.
      const known = (speakerCount.get(person) ?? 0) > 0;
      const identifiable = signal.durationMs >= IDENTIFIABLE_MS;
      const parts = {
        // Scaled so a dark voice holding a fifth of the room outranks a dark
        // voice holding a fortieth. The floor keeps quiet voices reachable.
        speaker:
          (WEIGHT.speaker / (1 + (speakerCount.get(person) ?? 0)))
          * (0.35 + 2.6 * (share.get(person) ?? 0))
          * (known ? 1 : (identifiable ? 1 : 0.15)),
        uncertainty: known ? WEIGHT.uncertainty * (1 - signal.margin) : WEIGHT.uncertainty * signal.margin * 0.5,
        shortTurn: !known
          ? 0
          : signal.durationMs > 0 && signal.durationMs < SHORT_TURN_MS ? WEIGHT.shortTurn : 0,
        timeline: WEIGHT.timeline / (1 + (bucketCount.get(bucketOf(line, recordingMs)) ?? 0)),
      };
      const score = parts.speaker + parts.uncertainty + parts.shortTurn + parts.timeline;
      // Ties break by time so the order is stable run to run.
      if (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) <= 1e-9 && line.at_ms < best.line.at_ms)) {
        best = { line, score, parts };
      }
    }
    if (!best) break;

    ranked.push({ id: best.line.id, score: Number(best.score.toFixed(4)), reason: reasonFor(best.parts, speakerCount, best.line) });
    remaining.delete(best.line.id);
    const person = best.line.person_id ?? 'unknown';
    speakerCount.set(person, (speakerCount.get(person) ?? 0) + 1);
    const bucket = bucketOf(best.line, recordingMs);
    bucketCount.set(bucket, (bucketCount.get(bucket) ?? 0) + 1);
  }
  return ranked;
}

function reasonFor(
  parts: Record<string, number>,
  speakerCount: Map<string, number>,
  line: QueueLine,
): string {
  const confirmed = speakerCount.get(line.person_id ?? 'unknown') ?? 0;
  const dominant = Object.entries(parts).sort((a, b) => b[1] - a[1])[0][0];
  if (dominant === 'speaker') {
    return confirmed === 0
      ? 'we have never had a confirmed line from this voice, and this is a long clear turn to identify it from'
      : `this voice has only ${confirmed} confirmed line${confirmed === 1 ? '' : 's'}`;
  }
  if (dominant === 'uncertainty') return 'two speakers hold almost equal shares of this line';
  if (dominant === 'shortTurn') return 'a turn under a second, where attribution fails most often';
  return 'this stretch of the recording has no ground truth yet';
}

/** Where each voice stands, so he can see when a voice stops being a blind spot. */
export function speakerCoverage(
  lines: QueueLine[],
  confirmedBySpeaker: Map<string, number>,
): SpeakerCoverage[] {
  const total = new Map<string, number>();
  const ms = new Map<string, number>();
  for (const line of lines) {
    const person = line.person_id ?? 'unknown';
    total.set(person, (total.get(person) ?? 0) + 1);
    ms.set(person, (ms.get(person) ?? 0) + Math.max(0, line.end_ms - line.at_ms));
  }
  const share = speechShare(lines);
  return [...total.entries()]
    .map(([person_id, count]) => {
      const confirmed = confirmedBySpeaker.get(person_id) ?? 0;
      return {
        person_id,
        confirmed,
        lines: count,
        speaking_ms: ms.get(person_id) ?? 0,
        share: share.get(person_id) ?? 0,
        wanted: Math.max(0, TARGET_PER_SPEAKER - confirmed),
      };
    })
    // Darkest and largest first: that is the order he should work in.
    .sort((a, b) => b.wanted - a.wanted || b.speaking_ms - a.speaking_ms);
}
