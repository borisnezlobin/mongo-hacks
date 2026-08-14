import { OWNER_ID } from '../../shared/contracts';
import type { Fact, Id, SearchMemoryResult } from '../../shared/contracts';
import { collections } from '../memory/db';
import { embedQuery } from '../memory/embeddings';

const CANDIDATES = 100;
const LIMIT = 10;
/** Reciprocal-rank-fusion constant; 60 is the value $rankFusion itself defaults to. */
const RRF_K = 60;

/**
 * `$rankFusion` is a recent aggregation stage. Where the sandbox cluster is too
 * old for it we run the same two pipelines and fuse the ranks by hand, so the
 * retrieval quality of the demo does not depend on the cluster version.
 */
export const useRankFusion = (): boolean => process.env.ASK_RRF_FALLBACK !== '1';

function factFilter(personId?: Id) {
  return {
    owner_id: OWNER_ID,
    ...(personId ? { person_id: personId } : {}),
    superseded_by: { $in: [null, undefined] },
  };
}

function toResult(fact: Fact, score: number): SearchMemoryResult {
  return {
    kind: 'fact',
    id: fact._id,
    person_id: fact.person_id,
    text: fact.claim,
    score,
    source_utterance_id: fact.primary_source_utterance_id,
  };
}

function vectorStage(embedding: number[], personId?: Id) {
  return {
    $vectorSearch: {
      index: 'facts_vector',
      path: 'embedding',
      queryVector: embedding,
      numCandidates: CANDIDATES,
      limit: LIMIT,
      filter: { owner_id: OWNER_ID, ...(personId ? { person_id: personId } : {}) },
    },
  };
}

function lexicalStage(query: string, personId?: Id) {
  const must: Record<string, unknown>[] = [
    { text: { query, path: ['claim', 'attribute'] } },
    { equals: { path: 'owner_id', value: OWNER_ID } },
  ];
  if (personId) must.push({ equals: { path: 'person_id', value: personId } });
  return { $search: { index: 'facts_text', compound: { must } } };
}

async function rankFusionSearch(query: string, embedding: number[], personId?: Id): Promise<SearchMemoryResult[]> {
  const pipeline = [
    {
      $rankFusion: {
        input: {
          pipelines: {
            semantic: [vectorStage(embedding, personId)],
            lexical: [lexicalStage(query, personId), { $limit: LIMIT }],
          },
        },
        scoreDetails: false,
      },
    },
    { $match: { superseded_by: { $in: [null, undefined] } } },
    { $limit: LIMIT },
    { $addFields: { fusion_score: { $meta: 'score' } } },
  ];
  const docs = await collections.facts().aggregate<Fact & { fusion_score?: number }>(pipeline).toArray();
  return docs.map((doc) => toResult(doc, doc.fusion_score ?? 0));
}

async function manualRrfSearch(query: string, embedding: number[], personId?: Id): Promise<SearchMemoryResult[]> {
  const [semantic, lexical] = await Promise.all([
    collections
      .facts()
      .aggregate<Fact>([vectorStage(embedding, personId), { $match: factFilter(personId) }, { $limit: LIMIT }])
      .toArray(),
    collections
      .facts()
      .aggregate<Fact>([lexicalStage(query, personId), { $match: factFilter(personId) }, { $limit: LIMIT }])
      .toArray()
      // A cluster without the Search index still answers via the semantic leg.
      .catch(() => [] as Fact[]),
  ]);

  const fused = new Map<Id, { fact: Fact; score: number }>();
  for (const ranking of [semantic, lexical]) {
    ranking.forEach((fact, index) => {
      const entry = fused.get(fact._id) ?? { fact, score: 0 };
      entry.score += 1 / (RRF_K + index + 1);
      fused.set(fact._id, entry);
    });
  }
  return [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, LIMIT)
    .map((entry) => toResult(entry.fact, entry.score));
}

/** Only ever returns live facts: a superseded claim must never reach an answer. */
export async function searchFacts(query: string, personId?: Id): Promise<SearchMemoryResult[]> {
  const embedding = await embedQuery(query);
  if (!useRankFusion()) return manualRrfSearch(query, embedding, personId);
  try {
    return await rankFusionSearch(query, embedding, personId);
  } catch (error) {
    console.warn('$rankFusion unavailable, falling back to hand-rolled RRF:', (error as Error).message);
    return manualRrfSearch(query, embedding, personId);
  }
}

/**
 * Promises and raw utterances are small enough at demo scale that a lexical scan
 * beats spending one of the three Atlas search-index slots on them.
 */
export async function searchPromisesAndUtterances(query: string, personId?: Id): Promise<SearchMemoryResult[]> {
  const terms = query.split(/\s+/).filter((term) => term.length > 3);
  if (terms.length === 0) return [];
  const pattern = new RegExp(terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');

  const [promises, utterances] = await Promise.all([
    collections
      .promises()
      .find({ owner_id: OWNER_ID, status: 'open', ...(personId ? { person_id: personId } : {}), text: pattern })
      .limit(5)
      .toArray(),
    collections
      .utterances()
      .find({ owner_id: OWNER_ID, ...(personId ? { person_id: personId } : {}), text: pattern })
      .limit(5)
      .toArray(),
  ]);

  return [
    ...promises.map((promise) => ({
      kind: 'promise' as const,
      id: promise._id,
      person_id: promise.person_id,
      text: promise.text,
      score: 0.5,
      source_utterance_id: promise.source_utterance_id,
    })),
    ...utterances.map((utterance) => ({
      kind: 'utterance' as const,
      id: utterance._id,
      person_id: utterance.person_id,
      text: utterance.text,
      score: 0.25,
      source_utterance_id: utterance._id,
    })),
  ];
}

export async function searchMemory(query: string, personId?: Id): Promise<SearchMemoryResult[]> {
  const [facts, rest] = await Promise.all([
    searchFacts(query, personId),
    searchPromisesAndUtterances(query, personId),
  ]);
  return [...facts, ...rest];
}
