import type { Id, SearchMemoryResult } from '../../shared/contracts';
import { collections } from '../memory/db';
import { embedQueries } from '../memory/embeddings';
import { extractStructured } from '../memory/llm';
import { hybridFactSearch, scanPromisesAndUtterances } from './candidates';
import { retrievalConfig, type RetrievalConfig } from './config';
import { capPerAttribute, fuseCandidates, type RankedList } from './fusion';
import { planQuery, type QueryPlan } from './query-plan';
import { rerankCandidates } from './rerank';
import { toSearchResult, type Candidate, type Filter, type RetrievalDeps } from './types';

/**
 * How much each formulation of the question is trusted in the cross-query fusion.
 * The asker's own words win ties; an invented hypothetical answer and a
 * paraphrase are useful for recall but are the pipeline's guesses, not theirs.
 */
const WEIGHT = { original: 1, hypothetical: 0.9, variant: 0.7, scan: 0.5 } as const;

export interface RetrievalOptions {
  deps?: RetrievalDeps;
  config?: Partial<RetrievalConfig>;
}

/** Kept for callers that only need to know which fusion path the cluster supports. */
export const useRankFusion = (): boolean => retrievalConfig().rankFusion;

function defaultDeps(): RetrievalDeps {
  return {
    collections: {
      facts: { aggregate: (pipeline) => collections.facts().aggregate(pipeline) },
      promises: {
        find: (filter: Filter) =>
          collections.promises().find(filter as Parameters<ReturnType<typeof collections.promises>['find']>[0]),
      },
      utterances: {
        find: (filter: Filter) =>
          collections.utterances().find(filter as Parameters<ReturnType<typeof collections.utterances>['find']>[0]),
      },
    },
    embedQueries,
    complete: extractStructured,
  };
}

/** Losing one leg should cost that leg's recall, not the whole answer. */
async function tolerate(label: string, work: Promise<Candidate[]>): Promise<Candidate[]> {
  try {
    return await work;
  } catch (error) {
    console.warn(`retrieval leg "${label}" failed:`, (error as Error).message);
    return [];
  }
}

/** The formulations to embed, in the order their weights are assigned below. */
function formulations(plan: QueryPlan): Array<{ text: string; weight: number }> {
  return [
    ...(plan.hypothetical ? [{ text: plan.hypothetical, weight: WEIGHT.hypothetical }] : []),
    ...plan.variants.map((text) => ({ text, weight: WEIGHT.variant })),
  ];
}

/**
 * Stages 2 and 3: fan the plan out over the hybrid fact index and fuse the
 * rankings back together. The original question is searched first and in
 * parallel with planning, so stage 1's latency is mostly hidden behind a leg
 * that would have run anyway.
 */
async function recallFacts(
  plan: QueryPlan,
  baseline: Candidate[],
  deps: RetrievalDeps,
  config: RetrievalConfig,
  personId?: Id,
): Promise<RankedList[]> {
  const extra = formulations(plan);
  if (extra.length === 0) return [{ weight: WEIGHT.original, items: baseline }];

  let embeddings: number[][] = [];
  try {
    embeddings = await deps.embedQueries(extra.map((entry) => entry.text));
  } catch (error) {
    console.warn('embedding the expanded queries failed, using the original only:', (error as Error).message);
    return [{ weight: WEIGHT.original, items: baseline }];
  }

  const expanded = await Promise.all(
    extra.map((entry, index) => {
      const embedding = embeddings[index];
      if (!embedding) return Promise.resolve<Candidate[]>([]);
      return tolerate(
        `variant:${entry.text}`,
        hybridFactSearch(deps, config, entry.text, embedding, personId),
      );
    }),
  );

  return [
    { weight: WEIGHT.original, items: baseline },
    ...expanded.map((items, index) => ({ weight: extra[index]!.weight, items })),
  ];
}

async function baselineFacts(
  query: string,
  deps: RetrievalDeps,
  config: RetrievalConfig,
  personId?: Id,
): Promise<Candidate[]> {
  const [embedding] = await deps.embedQueries([query]);
  if (!embedding) return [];
  return hybridFactSearch(deps, config, query, embedding, personId);
}

async function run(
  query: string,
  personId: Id | undefined,
  includeScan: boolean,
  options: RetrievalOptions,
): Promise<SearchMemoryResult[]> {
  const config = retrievalConfig(options.config);
  const deps = options.deps ?? defaultDeps();

  // Stage 1 runs against the clock of a leg that does not depend on it.
  const [baseline, plan] = await Promise.all([
    tolerate('baseline', baselineFacts(query, deps, config, personId)),
    planQuery(query, deps, config),
  ]);

  const [rankings, scanned] = await Promise.all([
    recallFacts(plan, baseline, deps, config, personId),
    includeScan
      ? tolerate('scan', scanPromisesAndUtterances(deps, config, plan.keywords, personId))
      : Promise.resolve<Candidate[]>([]),
  ]);

  const fused = fuseCandidates([...rankings, { weight: WEIGHT.scan, items: scanned }]);
  if (fused.length === 0) return [];

  // Stage 4 sees a wide pool and stage 5 trims it, so precision costs no recall.
  const reranked = await rerankCandidates(query, fused.slice(0, config.rerankPool), deps, config);
  return capPerAttribute(reranked, config.attributeCap)
    .slice(0, config.limit)
    .map(toSearchResult);
}

/** Only ever returns live facts: a superseded claim must never reach an answer. */
export function searchFacts(
  query: string,
  personId?: Id,
  options: RetrievalOptions = {},
): Promise<SearchMemoryResult[]> {
  return run(query, personId, false, options);
}

export function searchPromisesAndUtterances(
  query: string,
  personId?: Id,
  options: RetrievalOptions = {},
): Promise<SearchMemoryResult[]> {
  const config = retrievalConfig(options.config);
  const deps = options.deps ?? defaultDeps();
  return tolerate('scan', scanPromisesAndUtterances(deps, config, query.split(/\s+/), personId)).then(
    (candidates) => candidates.map(toSearchResult),
  );
}

/**
 * Five stages: plan the query, recall over every formulation, fuse the rankings,
 * rerank the pool against the question, then trim for diversity. Each stage after
 * recall is skippable, and a failure in any one of them degrades to the stage
 * before it rather than to an error.
 */
export function searchMemory(
  query: string,
  personId?: Id,
  options: RetrievalOptions = {},
): Promise<SearchMemoryResult[]> {
  return run(query, personId, true, options);
}
