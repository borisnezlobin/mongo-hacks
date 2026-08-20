/**
 * Ranking maths for memory search. Pure: documents in, ordered ids out.
 *
 * Retrieval used to be three Atlas-only aggregation stages — `$vectorSearch`,
 * `$search` and `$rankFusion` — which meant search worked only against a
 * reachable Atlas cluster with three applied search indexes, and could not be
 * tested without one. At this corpus size (one person's conversations, not a
 * web index) exact scoring in process is both cheaper and better than
 * approximate nearest neighbour, and it can be unit tested.
 */

/** Words too common to discriminate between one person's memories. */
const STOP_WORDS = new Set([
  'a', 'about', 'am', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'been', 'but', 'by',
  'can', 'did', 'do', 'does', 'for', 'from', 'get', 'got', 'had', 'has', 'have', 'he',
  'her', 'him', 'his', 'how', 'i', 'if', 'in', 'is', 'it', 'its', 'just', 'like', 'me',
  'my', 'not', 'of', 'on', 'or', 'our', 'out', 's', 'she', 'so', 'some', 't', 'that',
  'the', 'their', 'them', 'then', 'there', 'they', 'this', 'to', 'up', 'was', 'we',
  'were', 'what', 'when', 'where', 'which', 'who', 'will', 'with', 'would', 'you', 'your',
]);

/**
 * Split text into comparable terms.
 *
 * Deliberately keeps short tokens. The previous implementation dropped
 * everything under four characters, which threw away "job", "gym", "8am", and
 * every two-or-three letter name — exactly the words a question about a person
 * turns on.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}']+/u)
    .filter((term) => term.length > 0 && !STOP_WORDS.has(term));
}

export interface ScoredDocument {
  id: string;
  text: string;
  embedding?: number[];
}

const BM25_K1 = 1.2;
const BM25_B = 0.75;

/**
 * Okapi BM25 over the candidate set.
 *
 * The thing this fixes: the old lexical leg built one alternation regex from
 * the query and treated every hit as equally good, so a memory that merely
 * contained "app" ranked with one that was about the transit app. BM25 rewards
 * rare terms and discounts long documents, which is the whole difference
 * between finding the right turn and finding a turn.
 */
export function bm25(query: string, documents: ScoredDocument[]): Map<string, number> {
  const queryTerms = tokenize(query);
  const scores = new Map<string, number>();
  if (queryTerms.length === 0 || documents.length === 0) return scores;

  const tokenized = documents.map((document) => ({ document, terms: tokenize(document.text) }));
  const averageLength =
    tokenized.reduce((total, entry) => total + entry.terms.length, 0) / tokenized.length || 1;

  const documentFrequency = new Map<string, number>();
  for (const term of new Set(queryTerms)) {
    documentFrequency.set(term, tokenized.filter((entry) => entry.terms.includes(term)).length);
  }

  for (const { document, terms } of tokenized) {
    let score = 0;
    for (const term of new Set(queryTerms)) {
      const frequency = terms.filter((candidate) => candidate === term).length;
      if (frequency === 0) continue;
      const seen = documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (tokenized.length - seen + 0.5) / (seen + 0.5));
      const norm = frequency + BM25_K1 * (1 - BM25_B + (BM25_B * terms.length) / averageLength);
      score += idf * ((frequency * (BM25_K1 + 1)) / norm);
    }
    if (score > 0) scores.set(document.id, score);
  }
  return scores;
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length && i < b.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  return magnitude === 0 ? 0 : dot / magnitude;
}

/**
 * How close a document has to be before nearest counts as related.
 *
 * Cosine similarity always returns something, so without a floor the semantic
 * leg ranks the whole collection and rank fusion turns "least unrelated" into a
 * hit. The consequence was upstream and worse than a bad ordering: `searchFacts`
 * returned its full limit for every query including `zzzz qqqq xxxx`, so
 * retrieval could never report thin results, the coverage-assembly path that
 * broad questions depend on was unreachable, and the "nothing in memory"
 * refusal could not fire.
 *
 * Calibration, so a later reader knows how much this number is worth: measured
 * once, against the 38 live facts of one seeded 48-minute conversation, with
 * twelve hand-written questions. Six the memory answers scored 0.721 to 0.906
 * against their best fact; six it has nothing on — Bolivian tin, scuba in
 * Belize, a bicycle inner tube — scored 0.448 to 0.548 against theirs. Nothing
 * landed in between, so any floor from 0.56 to 0.72 separates them and this is
 * the middle of that gap. Re-checked afterwards over twelve person-and-attribute
 * questions: the floor cost the answer-bearing fact in none of them.
 *
 * Of the two thresholds retrieval now leans on, this is the better evidenced —
 * a 0.17-wide gap with no observations inside it. The other is THIN_RESULTS in
 * ask/index.ts, and its comment says why it is the weaker.
 */
const RELEVANCE_FLOOR = 0.64;

export function semanticScores(
  queryEmbedding: readonly number[] | undefined,
  documents: ScoredDocument[],
  floor = RELEVANCE_FLOOR,
): Map<string, number> {
  const scores = new Map<string, number>();
  if (!queryEmbedding || queryEmbedding.length === 0) return scores;
  for (const document of documents) {
    if (!document.embedding?.length) continue;
    const similarity = cosine(queryEmbedding, document.embedding);
    if (similarity >= floor) scores.set(document.id, similarity);
  }
  return scores;
}

/** The constant `$rankFusion` itself defaults to. */
const RRF_K = 60;

/**
 * Fuse rankings by reciprocal rank.
 *
 * Rank-based rather than score-based on purpose: a BM25 score and a cosine
 * similarity are not on the same scale, and the previous code mixed them with
 * hardcoded literals (0.5 for any promise, 0.25 for any utterance) into one
 * `score` field, which made the final ordering meaningless across kinds.
 */
export function fuseByRank(rankings: Map<string, number>[], k = RRF_K): Map<string, number> {
  const fused = new Map<string, number>();
  for (const ranking of rankings) {
    const ordered = [...ranking.entries()].sort((a, b) => b[1] - a[1]);
    ordered.forEach(([id], index) => {
      fused.set(id, (fused.get(id) ?? 0) + 1 / (k + index + 1));
    });
  }
  return fused;
}

export function topN<T extends { id: string }>(
  documents: T[],
  scores: Map<string, number>,
  limit: number,
): Array<{ document: T; score: number }> {
  return documents
    .map((document) => ({ document, score: scores.get(document.id) ?? 0 }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
