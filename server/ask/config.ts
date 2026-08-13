/**
 * Every stage past plain vector search is optional. A hackathon demo that loses
 * its inference key should degrade to hybrid-search-only rather than to nothing,
 * so each stage reads its own switch and the pipeline routes around it.
 */
export interface RetrievalConfig {
  /** Stage 1: LLM query planning (paraphrases, keywords, hypothetical answer). */
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
  /** Candidates shown to the reranker. */
  rerankPool: number;
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
    plan: boolEnv('ASK_QUERY_PLANNING', true),
    rerank: boolEnv('ASK_RERANK', true),
    rankFusion: !boolEnv('ASK_RRF_FALLBACK', false),
    maxVariants: intEnv('ASK_MAX_VARIANTS', 3),
    numCandidates: intEnv('ASK_NUM_CANDIDATES', 200),
    legLimit: intEnv('ASK_LEG_LIMIT', 25),
    rerankPool: intEnv('ASK_RERANK_POOL', 24),
    scanLimit: intEnv('ASK_SCAN_LIMIT', 5),
    attributeCap: intEnv('ASK_ATTRIBUTE_CAP', 2),
    limit: intEnv('ASK_LIMIT', 10),
    ...overrides,
  };
}
