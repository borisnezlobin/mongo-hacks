/**
 * Exact nearest-neighbour search, in process.
 *
 * At this corpus size — hundreds of people, low thousands of facts — an exact
 * scan over 192- or 768-float vectors is a few million multiply-adds, which is
 * faster than a network round trip to an approximate index and, unlike Atlas
 * Vector Search, works with no cloud and no index build.
 */

export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

/**
 * Atlas reports cosine as `(cosine + 1) / 2`. `rawCosine` in the identity
 * service undoes exactly that, so the local driver has to report the same
 * normalised form or every threshold in shared/contracts.ts shifts.
 */
export function toAtlasScore(cosine: number): number {
  return (cosine + 1) / 2;
}

export interface ScoredCandidate<T> {
  document: T;
  /** Raw cosine in [-1, 1]. */
  cosine: number;
}

export function rankByCosine<T>(
  documents: readonly T[],
  embeddingOf: (document: T) => readonly number[] | undefined,
  query: readonly number[],
  limit: number,
): ScoredCandidate<T>[] {
  const scored: ScoredCandidate<T>[] = [];
  for (const document of documents) {
    const embedding = embeddingOf(document);
    if (!embedding || embedding.length === 0) continue;
    scored.push({ document, cosine: cosineSimilarity(query, embedding) });
  }
  scored.sort((left, right) => right.cosine - left.cosine);
  return scored.slice(0, Math.max(0, limit));
}
