import type { Id } from '../../shared/contracts';
import { todayIsoDate } from '../memory/normalize';
import type { RetrievalConfig } from './config';
import { normalizeScores } from './fusion';
import type { Candidate, RetrievalDeps } from './types';

const MAX_RELEVANCE = 3;
/** An item nobody scored is treated as weakly relevant, not as rejected. */
const UNJUDGED = 1;
/** Recall order still breaks ties, but the judgement dominates it. */
const JUDGEMENT_WEIGHT = 0.75;

export type Judgements = Map<Id, number>;

const RERANK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['rankings'],
  properties: {
    rankings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['item', 'relevance'],
        properties: {
          item: { type: 'integer' },
          relevance: { type: 'integer', minimum: 0, maximum: MAX_RELEVANCE },
        },
      },
    },
  },
} as const;

/**
 * Kept short on purpose: the asker is waiting on this call, and a longer rubric
 * mostly buys reasoning tokens rather than better judgements.
 *
 * The scale is absolute — an item is scored against the question, not against
 * the other items — which is what lets separate batches be judged independently
 * and merged.
 */
const RERANK_SYSTEM = `Score each retrieved item against the question, by its own content.

3 answers it directly. 2 is the right person and subject and narrows the answer.
1 is related background. 0 is a keyword or vector coincidence.

Retrieval is recall-oriented, so many 0s are expected. Score every item given, using
the numbers shown in brackets. Answer immediately. Do not deliberate.`;

function render(candidate: Candidate, index: number): string {
  const parts = [
    `[${index}]`,
    `kind=${candidate.kind}`,
    candidate.attribute ? `attribute=${candidate.attribute}` : '',
    candidate.stated_at ? `stated=${candidate.stated_at.slice(0, 10)}` : '',
    candidate.person_id ? `person=${candidate.person_id}` : '',
  ].filter(Boolean);
  return `${parts.join(' ')}\n${candidate.text}`;
}

/**
 * Stage 4. Fusion ranks on lexical overlap and vector proximity, neither of which
 * knows what the question is asking; a model reading the question against each
 * candidate does. Items are addressed by position because the model reproduces a
 * small integer reliably and a UUID it does not.
 *
 * The whole pool goes in one request. Splitting it across concurrent requests
 * was measurably slower: the inference account serialises them, so a second
 * request costs its full latency rather than overlapping.
 */
export async function judgeCandidates(
  query: string,
  candidates: Candidate[],
  deps: RetrievalDeps,
  config: RetrievalConfig,
): Promise<Judgements> {
  if (!config.rerank || candidates.length === 0) return new Map();

  try {
    const reply = await deps.complete<{ rankings: Array<{ item: number; relevance: number }> }>({
      system: RERANK_SYSTEM,
      user: [
        `Today's date is ${todayIsoDate()}.`,
        `Question: ${query}`,
        '',
        'Items:',
        candidates.map(render).join('\n\n'),
      ].join('\n'),
      schema: RERANK_SCHEMA,
      // Roughly a dozen tokens per judgement, plus room for the model to think.
      maxTokens: 300 + candidates.length * 40,
      reasoningEffort: 'low',
    });

    const judgements: Judgements = new Map();
    for (const { item, relevance } of reply.rankings ?? []) {
      const candidate = candidates[item];
      if (!Number.isInteger(item) || !candidate) continue;
      judgements.set(candidate.id, Math.min(Math.max(relevance, 0), MAX_RELEVANCE));
    }
    return judgements;
  } catch (error) {
    console.warn('rerank failed, keeping fusion order:', (error as Error).message);
    // No judgements means every candidate is unjudged, which sorts back to
    // fusion order and drops nothing.
    return new Map();
  }
}

/**
 * Applies whatever judgements exist. Anything missing falls back to `UNJUDGED`,
 * so a truncated reply — or a reranker that never ran — degrades to recall order
 * instead of emptying the result set.
 */
export function applyJudgements(candidates: Candidate[], judgements: Judgements): Candidate[] {
  return normalizeScores(candidates)
    .map((candidate) => {
      const relevance = judgements.get(candidate.id) ?? UNJUDGED;
      return {
        candidate,
        relevance,
        blended:
          JUDGEMENT_WEIGHT * (relevance / MAX_RELEVANCE) + (1 - JUDGEMENT_WEIGHT) * candidate.score,
      };
    })
    .filter((entry) => entry.relevance > 0)
    .sort((a, b) => b.blended - a.blended)
    .map((entry) => ({ ...entry.candidate, score: entry.blended }));
}

/** Judge and apply in one step, for callers that already hold the final pool. */
export async function rerankCandidates(
  query: string,
  candidates: Candidate[],
  deps: RetrievalDeps,
  config: RetrievalConfig,
): Promise<Candidate[]> {
  if (!config.rerank) return normalizeScores(candidates);
  return applyJudgements(candidates, await judgeCandidates(query, candidates, deps, config));
}
