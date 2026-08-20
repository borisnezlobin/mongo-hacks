import { OWNER_ID } from '../../shared/contracts';
import type { Fact, Id, PromiseMemory, SearchMemoryResult, Utterance } from '../../shared/contracts';
import { collections } from '../memory/db';
import { embedQuery } from '../memory/embeddings';
import { loadTermMatchedUtterances, type UtteranceScope } from './corpus';
import { bm25, fuseByRank, semanticScores, tokenize, topN, type ScoredDocument } from './scoring';

/**
 * Relevance retrieval over one person's own memory.
 *
 * This half of retrieval answers "find me the thing about X" over facts, open
 * promises and raw transcript. The other half — "show me this scope" — lives in
 * context.ts, because a question like "what did we talk about" has no terms to
 * rank by and needs coverage rather than relevance.
 *
 * Two things were wrong before, and they compounded.
 *
 * It ran entirely on Atlas-only aggregation stages — `$vectorSearch`, `$search`
 * and `$rankFusion` — so search worked only against a reachable cluster with
 * three applied search indexes, and could not be tested without one. At this
 * corpus size (one student's conversations) exact scoring in process is faster
 * than the network round trip it replaces.
 *
 * And it searched *extracted facts only*, ten of them, so the model answered
 * from ten terse claims with the conversation stripped out. Facts are good at
 * "what is true now" and useless at "what did Tarun actually say". Raw
 * utterances are already stored, so this searches them too and lets the answer
 * quote the room.
 */

const FACT_LIMIT = 12;
const PROMISE_LIMIT = 6;
const UTTERANCE_LIMIT = 12;

const NOT_SUPERSEDED = { superseded_by: { $in: [null, undefined] } };

function scopeFilter(scope: UtteranceScope) {
  return { owner_id: OWNER_ID, ...(scope.person_id ? { person_id: scope.person_id } : {}) };
}

/**
 * The query embedding, or undefined when embeddings are unavailable.
 *
 * Lexical retrieval alone is a real answer, so an embeddings outage degrades
 * the ranking instead of failing the question. The old code let this reject
 * and took `/ask` down with it.
 */
async function queryEmbedding(query: string): Promise<number[] | undefined> {
  try {
    const embedding = await embedQuery(query);
    return Array.isArray(embedding) && embedding.length > 0 ? embedding : undefined;
  } catch (error) {
    console.warn('[ask] embedding unavailable, answering lexically:', (error as Error).message);
    return undefined;
  }
}

/** Only ever returns live facts: a superseded claim must never reach an answer. */
export async function searchFacts(query: string, scope: UtteranceScope = {}): Promise<SearchMemoryResult[]> {
  const facts = await collections
    .facts()
    .find({ ...scopeFilter(scope), ...NOT_SUPERSEDED })
    .toArray();
  if (facts.length === 0) return [];

  const documents: ScoredDocument[] = facts.map((fact) => ({
    id: fact._id,
    text: `${fact.attribute} ${fact.claim}`,
    embedding: fact.embedding,
  }));

  const fused = fuseByRank([
    bm25(query, documents),
    semanticScores(await queryEmbedding(query), documents),
  ]);

  const byId = new Map(facts.map((fact) => [fact._id, fact]));
  return topN(documents, fused, FACT_LIMIT).map(({ document, score }) => {
    const fact = byId.get(document.id) as Fact;
    return {
      kind: 'fact' as const,
      id: fact._id,
      person_id: fact.person_id,
      text: fact.claim,
      score,
      source_utterance_id: fact.primary_source_utterance_id,
    };
  });
}

/**
 * Open promises and raw transcript.
 *
 * The transcript leg no longer reads "the newest N utterances and rank those".
 * That heuristic — 4,000 turns — was already under water: one 48-minute
 * recording is ~2,770 turns, so the second day of recording pushed the first
 * out of reach and no ranking could recover it. Candidates now come from the
 * storage driver's inverted index on `utterances.text`: every turn in the
 * corpus that contains at least one term from the question, however old, and
 * nothing else. Cost scales with how rare the words are, not with how long the
 * owner has been recording.
 *
 * Scores are reciprocal-rank values on the same scale as `searchFacts`, so the
 * three kinds are actually comparable. They used to be the literals 0.5 and
 * 0.25, which meant every promise outranked every utterance regardless of
 * whether it had anything to do with the question.
 */
export async function searchPromisesAndUtterances(
  query: string,
  scope: UtteranceScope = {},
): Promise<SearchMemoryResult[]> {
  if (tokenize(query).length === 0) return [];

  const [promises, matched] = await Promise.all([
    collections
      .promises()
      .find({ ...scopeFilter(scope), status: 'open' })
      .toArray(),
    loadTermMatchedUtterances(query, scope),
  ]);

  const utterances = scope.conversation_id
    ? matched.filter((utterance) => utterance.conversation_id === scope.conversation_id)
    : matched;

  const promiseDocs: ScoredDocument[] = promises.map((promise) => ({
    id: promise._id,
    text: promise.text,
  }));
  const utteranceDocs: ScoredDocument[] = utterances.map((utterance) => ({
    id: utterance._id,
    text: utterance.text,
  }));

  const promiseById = new Map(promises.map((promise) => [promise._id, promise]));
  const utteranceById = new Map(utterances.map((utterance) => [utterance._id, utterance]));

  const rankedPromises = topN(promiseDocs, fuseByRank([bm25(query, promiseDocs)]), PROMISE_LIMIT);
  const rankedUtterances = topN(
    utteranceDocs,
    fuseByRank([bm25(query, utteranceDocs)]),
    UTTERANCE_LIMIT,
  );

  return [
    ...rankedPromises.map(({ document, score }) => {
      const promise = promiseById.get(document.id) as PromiseMemory;
      return {
        kind: 'promise' as const,
        id: promise._id,
        person_id: promise.person_id,
        text: promise.text,
        score,
        source_utterance_id: promise.source_utterance_id,
      };
    }),
    ...rankedUtterances.map(({ document, score }) => {
      const utterance = utteranceById.get(document.id) as Utterance;
      return {
        kind: 'utterance' as const,
        id: utterance._id,
        person_id: utterance.person_id,
        text: utterance.text,
        score,
        source_utterance_id: utterance._id,
      };
    }),
  ];
}

/**
 * Utterances that a later fact has already overtaken.
 *
 * A superseded fact still points at the turn that produced it, and quoting that
 * turn is how an answer confidently states last month's move-in date. Dropping
 * exactly those turns is precise; dropping every utterance whenever any fact
 * matched — which is what the previous guard did — threw away the transcript
 * that questions about what somebody *said* depend on.
 */
export async function supersededSourceUtteranceIds(scope: UtteranceScope = {}): Promise<Set<Id>> {
  const superseded = await collections
    .facts()
    .find({ ...scopeFilter(scope), superseded_by: { $exists: true } })
    .toArray();
  return new Set(
    superseded
      .filter((fact) => Boolean(fact.superseded_by))
      .map((fact) => fact.primary_source_utterance_id),
  );
}

export async function searchMemoryScoped(
  query: string,
  scope: UtteranceScope = {},
): Promise<SearchMemoryResult[]> {
  const [facts, rest, stale] = await Promise.all([
    searchFacts(query, scope),
    searchPromisesAndUtterances(query, scope),
    supersededSourceUtteranceIds(scope),
  ]);
  return [...facts, ...rest]
    .filter((result) => !(result.kind === 'utterance' && stale.has(result.id)))
    .sort((a, b) => b.score - a.score);
}

/** The shape the frozen MemoryApi asks for. */
export async function searchMemory(query: string, personId?: Id): Promise<SearchMemoryResult[]> {
  return searchMemoryScoped(query, { person_id: personId });
}
