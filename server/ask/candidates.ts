import { OWNER_ID } from '../../shared/contracts';
import type { Fact, Id, PromiseMemory, Utterance } from '../../shared/contracts';
import type { RetrievalConfig } from './config';
import { fuseCandidates } from './fusion';
import { factCandidate, type Candidate, type Filter, type PipelineStage, type RetrievalDeps } from './types';

/** A superseded claim must never reach an answer, so every leg filters for live facts. */
const LIVE = { superseded_by: { $in: [null, undefined] } };

function scope(personId?: Id): Filter {
  return { owner_id: OWNER_ID, ...(personId ? { person_id: personId } : {}) };
}

export function vectorStage(embedding: number[], config: RetrievalConfig, personId?: Id): PipelineStage {
  return {
    $vectorSearch: {
      index: 'facts_vector',
      path: 'embedding',
      queryVector: embedding,
      numCandidates: config.numCandidates,
      limit: config.legLimit,
      // `superseded_by` is not an indexed filter path, so supersession is a $match
      // below rather than part of the vector prefilter.
      filter: scope(personId),
    },
  };
}

export function lexicalStage(text: string, personId?: Id): PipelineStage {
  const must: Record<string, unknown>[] = [
    { text: { query: text, path: ['claim', 'attribute'] } },
    { equals: { path: 'owner_id', value: OWNER_ID } },
  ];
  if (personId) must.push({ equals: { path: 'person_id', value: personId } });
  return { $search: { index: 'facts_text', compound: { must } } };
}

/**
 * Filtering inside each input pipeline rather than after fusion. The outer
 * `$match` that Lane B shipped first cost slots: a leg could spend its whole
 * limit on superseded claims and contribute nothing.
 */
function rankFusionPipeline(text: string, embedding: number[], config: RetrievalConfig, personId?: Id) {
  return [
    {
      $rankFusion: {
        input: {
          pipelines: {
            semantic: [vectorStage(embedding, config, personId), { $match: LIVE }],
            lexical: [lexicalStage(text, personId), { $match: LIVE }, { $limit: config.legLimit }],
          },
        },
        scoreDetails: false,
      },
    },
    { $match: LIVE },
    { $limit: config.legLimit },
  ];
}

async function rankFusionLeg(
  deps: RetrievalDeps,
  config: RetrievalConfig,
  text: string,
  embedding: number[],
  personId?: Id,
): Promise<Candidate[]> {
  const docs = await deps.collections.facts
    .aggregate(rankFusionPipeline(text, embedding, config, personId))
    .toArray();
  return docs.map((doc) => factCandidate(doc));
}

async function manualRrfLeg(
  deps: RetrievalDeps,
  config: RetrievalConfig,
  text: string,
  embedding: number[],
  personId?: Id,
): Promise<Candidate[]> {
  const match = { $match: { ...scope(personId), ...LIVE } };
  const [semantic, lexical] = await Promise.all([
    deps.collections.facts
      .aggregate([vectorStage(embedding, config, personId), match, { $limit: config.legLimit }])
      .toArray(),
    deps.collections.facts
      .aggregate([lexicalStage(text, personId), match, { $limit: config.legLimit }])
      .toArray()
      // A cluster without the Search index still answers via the semantic leg.
      .catch(() => [] as Fact[]),
  ]);

  return fuseCandidates([
    { weight: 1, items: semantic.map((fact) => factCandidate(fact)) },
    { weight: 1, items: lexical.map((fact) => factCandidate(fact)) },
  ]);
}

/**
 * Stage 2, one query formulation. Prefers Atlas `$rankFusion` and keeps the
 * two-pipeline reciprocal-rank-fusion fallback for clusters that are too old for
 * it, so retrieval quality does not depend on the sandbox version.
 */
export async function hybridFactSearch(
  deps: RetrievalDeps,
  config: RetrievalConfig,
  text: string,
  embedding: number[],
  personId?: Id,
): Promise<Candidate[]> {
  if (!config.rankFusion) return manualRrfLeg(deps, config, text, embedding, personId);
  try {
    return await rankFusionLeg(deps, config, text, embedding, personId);
  } catch (error) {
    console.warn('$rankFusion unavailable, falling back to hand-rolled RRF:', (error as Error).message);
    return manualRrfLeg(deps, config, text, embedding, personId);
  }
}

/**
 * Promises and raw utterances are small enough at demo scale that a lexical scan
 * beats spending one of the three Atlas search-index slots on them. Planner
 * keywords make the scan sharper than splitting the raw question would.
 */
export async function scanPromisesAndUtterances(
  deps: RetrievalDeps,
  config: RetrievalConfig,
  keywords: string[],
  personId?: Id,
): Promise<Candidate[]> {
  const terms = keywords.filter((keyword) => keyword.length >= 3);
  if (terms.length === 0) return [];
  const pattern = new RegExp(terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');
  const filter = { ...scope(personId), text: pattern };

  const [promises, utterances] = await Promise.all([
    deps.collections.promises.find(filter).limit(config.scanLimit).toArray(),
    deps.collections.utterances.find(filter).limit(config.scanLimit).toArray(),
  ]);

  return [
    ...promises.map((promise: PromiseMemory) => ({
      id: promise._id,
      kind: 'promise' as const,
      text: promise.text,
      // Ranked below facts by default; the reranker is what moves them up.
      score: 0.5,
      person_id: promise.person_id,
      source_utterance_id: promise.source_utterance_id,
      stated_at: promise.created_at,
    })),
    ...utterances.map((utterance: Utterance) => ({
      id: utterance._id,
      kind: 'utterance' as const,
      text: utterance.text,
      score: 0.25,
      person_id: utterance.person_id,
      source_utterance_id: utterance._id,
      stated_at: utterance.created_at,
    })),
  ];
}
