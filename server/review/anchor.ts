/**
 * Re-attaching corrections to lines after the transcript underneath them moves.
 *
 * Corrections are keyed by `utterance_id`, and the seed regenerates those ids
 * positionally: `dorm-40min-u5` is whatever the sixth line happens to be today.
 * When the join changed from 917 lines to 767, two of his corrections landed on
 * a single merged line. Both happened to say Volva so nothing was lost, and
 * that is luck, not a mechanism.
 *
 * The durable identity of a correction is what he was looking at when he made
 * it: a time span and the words in it, both of which are already stored on
 * every record. This re-keys on those and refuses to guess when it cannot tell.
 *
 * Deliberately conservative. A correction that silently attaches to the wrong
 * line is worse than one reported as orphaned, because the whole point of this
 * page is that his ground truth can be trusted without re-checking it.
 */
import type { Correction } from './corrections';

export type AnchorState = 'exact' | 'rekeyed' | 'ambiguous' | 'orphaned';

export interface AnchoredCorrection {
  correction: Correction;
  /** The line it now belongs to, or null when nothing matched well enough. */
  utterance_id: string | null;
  state: AnchorState;
  detail: string;
}

export interface AnchorLine {
  id: string;
  at_ms: number;
  end_ms: number;
  text: string;
}

/** Punctuation and case drift with the transcriber; the words are the identity. */
export function normaliseText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function overlapMs(a: { at_ms: number; end_ms: number }, b: { at_ms: number; end_ms: number }): number {
  return Math.min(a.end_ms, b.end_ms) - Math.max(a.at_ms, b.at_ms);
}

/** Share of the correction's original span that a candidate line covers. */
function coverage(correction: Correction, line: AnchorLine): number {
  const span = Math.max(1, correction.end_ms - correction.at_ms);
  return Math.max(0, overlapMs(correction, { at_ms: line.at_ms, end_ms: line.end_ms })) / span;
}

const MIN_COVERAGE = 0.5;

export function anchorCorrections(corrections: Correction[], lines: AnchorLine[]): AnchoredCorrection[] {
  const byId = new Map(lines.map((line) => [line.id, line]));

  const anchored = corrections.map<AnchoredCorrection>((correction) => {
    const sameId = byId.get(correction.utterance_id);
    const wanted = normaliseText(correction.original_text);

    // The ordinary case: nothing moved, and the words at that id still match.
    if (sameId && (wanted === '' || normaliseText(sameId.text) === wanted)) {
      return { correction, utterance_id: sameId.id, state: 'exact', detail: 'the line is unchanged' };
    }

    const overlapping = lines
      .map((line) => ({ line, share: coverage(correction, line) }))
      .filter((candidate) => candidate.share > 0)
      .sort((a, b) => b.share - a.share);

    // A line whose words are exactly what he corrected, wherever it now sits.
    const textMatch = overlapping.filter((candidate) => wanted !== '' && normaliseText(candidate.line.text) === wanted);
    if (textMatch.length === 1) {
      return {
        correction,
        utterance_id: textMatch[0].line.id,
        state: 'rekeyed',
        detail: `moved to ${textMatch[0].line.id}: same words, same place in the recording`,
      };
    }
    if (textMatch.length > 1) {
      return {
        correction,
        utterance_id: null,
        state: 'ambiguous',
        detail: 'the same words now appear on more than one line here, so which one he meant is a guess',
      };
    }

    const best = overlapping[0];
    if (!best || best.share < MIN_COVERAGE) {
      return {
        correction,
        utterance_id: null,
        state: 'orphaned',
        detail: `nothing at ${(correction.at_ms / 1000).toFixed(1)}s still looks like "${correction.original_text.slice(0, 40)}"`,
      };
    }
    // The words changed but the time is right: the join re-cut this stretch.
    return {
      correction,
      utterance_id: best.line.id,
      state: 'ambiguous',
      detail:
        `the transcript here was re-cut, so this now sits inside "${best.line.text.slice(0, 40)}". `
        + 'Check it before trusting it',
    };
  });

  // Two corrections that disagree must never quietly merge onto one line. That
  // is the failure this file exists for, and it got away with it last time only
  // because both of them happened to say the same thing.
  const grouped = new Map<string, AnchoredCorrection[]>();
  for (const entry of anchored) {
    if (!entry.utterance_id || entry.state === 'exact') continue;
    grouped.set(entry.utterance_id, [...(grouped.get(entry.utterance_id) ?? []), entry]);
  }
  for (const [utteranceId, entries] of grouped) {
    if (entries.length < 2) continue;
    const claims = new Set(
      entries.map((entry) => `${entry.correction.speaker?.name.toLowerCase() ?? ''}|${normaliseText(entry.correction.text ?? '')}`),
    );
    if (claims.size <= 1) continue;
    for (const entry of entries) {
      entry.state = 'ambiguous';
      entry.detail = `${entries.length} corrections from different lines now land on ${utteranceId} and they do not agree`;
    }
  }

  return anchored;
}

export interface AnchorReport {
  exact: number;
  rekeyed: number;
  ambiguous: number;
  orphaned: number;
}

export function summariseAnchors(anchored: AnchoredCorrection[]): AnchorReport {
  const report: AnchorReport = { exact: 0, rekeyed: 0, ambiguous: 0, orphaned: 0 };
  for (const entry of anchored) report[entry.state] += 1;
  return report;
}
