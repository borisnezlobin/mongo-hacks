import type { Candidate } from './types';

/** Reciprocal-rank-fusion constant; 60 is the value `$rankFusion` itself defaults to. */
export const RRF_K = 60;

export interface RankedList {
  /** Relative trust in this formulation of the query. */
  weight: number;
  items: Candidate[];
}

/**
 * Rank-based rather than score-based fusion: a `$vectorSearch` cosine, a Lucene
 * BM25 score and a `$rankFusion` meta score share no scale, and reconciling them
 * would mean calibrating three moving vendor numbers. Position is comparable
 * across all of them.
 */
export function fuseCandidates(lists: RankedList[], k = RRF_K): Candidate[] {
  const fused = new Map<string, { candidate: Candidate; score: number }>();

  for (const { weight, items } of lists) {
    items.forEach((candidate, index) => {
      const entry = fused.get(candidate.id) ?? { candidate, score: 0 };
      entry.score += weight / (k + index + 1);
      // Legs can disagree on how much of a record they hydrate; keep the fullest copy.
      entry.candidate = { ...candidate, ...entry.candidate };
      fused.set(candidate.id, entry);
    });
  }

  return [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .map((entry) => ({ ...entry.candidate, score: entry.score }));
}

/** Rescale to 0..1 so a downstream consumer can read `score` without knowing which path ran. */
export function normalizeScores(candidates: Candidate[]): Candidate[] {
  const top = Math.max(...candidates.map((candidate) => candidate.score), 0);
  if (top <= 0) return candidates.map((candidate) => ({ ...candidate, score: 0 }));
  return candidates.map((candidate) => ({ ...candidate, score: candidate.score / top }));
}

/**
 * Supersession already removes stale claims, but a person can still hold several
 * live facts under one attribute, and they crowd out every other angle on the
 * question. Overflow is pushed to the tail instead of dropped: a thin result set
 * would rather have the third-best coffee fact than nothing.
 */
export function capPerAttribute(candidates: Candidate[], cap: number): Candidate[] {
  if (cap <= 0) return candidates;
  const seen = new Map<string, number>();
  const kept: Candidate[] = [];
  const overflow: Candidate[] = [];

  for (const candidate of candidates) {
    if (candidate.kind !== 'fact' || !candidate.attribute) {
      kept.push(candidate);
      continue;
    }
    const key = `${candidate.person_id ?? ''}::${candidate.attribute}`;
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    (count < cap ? kept : overflow).push(candidate);
  }

  return [...kept, ...overflow];
}
