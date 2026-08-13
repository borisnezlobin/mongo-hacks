import type { Id, SearchMemoryResult } from '../../shared/contracts';
import { collections } from '../memory/db';
import { embedQueries } from '../memory/embeddings';
import { extractStructured } from '../memory/llm';
import { hybridFactSearch, scanPromisesAndUtterances } from './candidates';
import { retrievalConfig, type RetrievalConfig } from './config';
import { capPerAttribute, fuseCandidates, normalizeScores, type RankedList } from './fusion';
import { fallbackPlan, keywordsFrom, planQuery, type QueryPlan } from './query-plan';
import { applyJudgements, judgeCandidates } from './rerank';
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

/**
 * Resolves to `fallback` if the work has not finished in time. The work is not
 * cancelled — there is nothing to cancel a fetch with here — it is simply no
 * longer waited on, and its result is discarded.
 */
function withDeadline<T>(work: Promise<T>, ms: number, fallback: T, label: string): Promise<T> {
  if (ms <= 0) return work;
  let timer: ReturnType<typeof setTimeout>;
  const expiry = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      console.warn(`${label} exceeded its ${ms} ms deadline; continuing without it`);
      resolve(fallback);
    }, ms);
  });
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer));
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

/** Every formulation to search, the question first, each with its fusion weight. */
function formulations(plan: QueryPlan): Array<{ text: string; weight: number }> {
  return [
    { text: plan.original, weight: WEIGHT.original },
    ...(plan.hypothetical ? [{ text: plan.hypothetical, weight: WEIGHT.hypothetical }] : []),
    ...plan.variants.map((text) => ({ text, weight: WEIGHT.variant })),
  ];
}

/**
 * Stages 2 and 3: fan the plan out over the hybrid fact index and fuse the
 * rankings back together.
 *
 * Every formulation is embedded in one request. The question could be embedded
 * earlier, overlapping the planner, but the inference account serialises
 * requests, so an extra round trip costs more than the overlap saves. Atlas is a
 * different service and does run its legs concurrently.
 */
async function recallFacts(
  plan: QueryPlan,
  deps: RetrievalDeps,
  config: RetrievalConfig,
  personId?: Id,
): Promise<RankedList[]> {
  const legs = formulations(plan);

  let embeddings: number[][] = [];
  try {
    embeddings = await deps.embedQueries(legs.map((leg) => leg.text));
  } catch (error) {
    console.warn('embedding the query failed, facts are unreachable:', (error as Error).message);
    return [];
  }

  return Promise.all(
    legs.map(async (leg, index) => {
      const embedding = embeddings[index];
      const items = embedding
        ? await tolerate(`leg:${leg.text}`, hybridFactSearch(deps, config, leg.text, embedding, personId))
        : [];
      return { weight: leg.weight, items };
    }),
  );
}

async function run(
  query: string,
  personId: Id | undefined,
  includeScan: boolean,
  options: RetrievalOptions,
): Promise<SearchMemoryResult[]> {
  const config = retrievalConfig(options.config);
  const deps = options.deps ?? defaultDeps();

  // Stage 1 is one inference request and it gates the rest, so it is bounded:
  // past the deadline the question is searched as the asker wrote it.
  const plan = await withDeadline(
    planQuery(query, deps, config),
    config.planDeadlineMs,
    fallbackPlan(query),
    'query planning',
  );

  // The keyword scan needs no plan and no embedding, so it rides along with the
  // Atlas legs rather than adding to the wait.
  const [rankings, scanned] = await Promise.all([
    recallFacts(plan, deps, config, personId),
    includeScan
      ? tolerate('scan', scanPromisesAndUtterances(deps, config, keywordsFrom(query), personId))
      : Promise.resolve<Candidate[]>([]),
  ]);

  const fused = fuseCandidates([...rankings, { weight: WEIGHT.scan, items: scanned }]);
  if (fused.length === 0) return [];

  // Stage 4 sees a wide pool and stage 5 trims it, so precision costs no recall.
  const pool = fused.slice(0, config.rerankPool);
  if (!config.rerank) return trim(normalizeScores(pool), config);
  return trim(applyJudgements(pool, await judgeCandidates(query, pool, deps, config)), config);
}

function trim(candidates: Candidate[], config: RetrievalConfig): SearchMemoryResult[] {
  return capPerAttribute(candidates, config.attributeCap).slice(0, config.limit).map(toSearchResult);
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
  return tolerate('scan', scanPromisesAndUtterances(deps, config, keywordsFrom(query), personId)).then(
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
