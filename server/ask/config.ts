/**
 * Every stage past plain vector search is optional. A hackathon demo that loses
 * its inference key should degrade to hybrid-search-only rather than to nothing,
 * so each stage reads its own switch and the pipeline routes around it.
 */
export interface RetrievalConfig {
  /**
   * Stage 1: LLM query planning (paraphrases and a hypothetical answer).
   *
   * Off by default. It is a whole inference request on the critical path —
   * measured at roughly 900 ms, about 40% of a full search — and against the
   * fixture memory it surfaced no fact the question had not already found. Turn
   * it on with `ASK_QUERY_PLANNING=1` once the memory is large enough that
   * vocabulary mismatch is a real risk.
   */
  plan: boolean;
  /** Stage 4: LLM relevance reranking over the fused candidate pool. */
  rerank: boolean;
  /** Prefer Atlas `$rankFusion` over the hand-rolled two-pipeline fallback. */
  rankFusion: boolean;
  /** Extra query formulations embedded alongside the original question. */
  maxVariants: number;
  /** `numCandidates` handed to `$vectorSearch`; recall widens, precision is the reranker's job. */
  numCandidates: number;
  /** Rows each retrieval leg returns before fusion. */
  legLimit: number;
  /**
   * Candidates shown to the reranker. Judging is one request whose reply grows
   * with the pool, so this is the main dial between recall and latency.
   */
  rerankPool: number;
  /**
   * How long stage 1 may hold up stage 2. Recall for the original question has
   * already run by the time this expires, so a slow planner costs the expansion,
   * never the answer.
   */
  planDeadlineMs: number;
  /** Promise and utterance rows the lexical scan may contribute. */
  scanLimit: number;
  /** Facts returned for a single (person, attribute) before the rest are pushed down. */
  attributeCap: number;
  /** Final result count. */
  limit: number;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(raw.toLowerCase());
}

function intEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Read per call rather than per module load so tests and the demo can flip a stage off. */
export function retrievalConfig(overrides: Partial<RetrievalConfig> = {}): RetrievalConfig {
  return {
    plan: boolEnv('ASK_QUERY_PLANNING', false),
    rerank: boolEnv('ASK_RERANK', true),
    rankFusion: !boolEnv('ASK_RRF_FALLBACK', false),
    maxVariants: intEnv('ASK_MAX_VARIANTS', 3),
    numCandidates: intEnv('ASK_NUM_CANDIDATES', 200),
    legLimit: intEnv('ASK_LEG_LIMIT', 25),
    rerankPool: intEnv('ASK_RERANK_POOL', 16),
    planDeadlineMs: intEnv('ASK_PLAN_DEADLINE_MS', 1_200),
    scanLimit: intEnv('ASK_SCAN_LIMIT', 5),
    attributeCap: intEnv('ASK_ATTRIBUTE_CAP', 2),
    limit: intEnv('ASK_LIMIT', 10),
    ...overrides,
  };
}
