import { todayIsoDate } from '../memory/normalize';
import type { RetrievalConfig } from './config';
import { normalizeScores } from './fusion';
import type { Candidate, RetrievalDeps } from './types';

const MAX_RELEVANCE = 3;
/** An item the model never scored is treated as weakly relevant, not as rejected. */
const UNJUDGED = 1;
/** Recall order still breaks ties, but the judgement dominates it. */
const JUDGEMENT_WEIGHT = 0.75;

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

const RERANK_SYSTEM = `You judge how well each retrieved memory item answers a question.

Score every item you are given:
3 — answers the question directly.
2 — is about the right person and subject and materially narrows the answer.
1 — related background that a careful answer might mention.
0 — retrieved by keyword or vector coincidence and does not bear on the question.

Judge the item on its own content, not on the order it was given in. Retrieval is
recall-oriented, so scoring several items 0 is expected and correct. Do not invent
items and do not skip any.`;

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
 * Applies judgements the model actually returned; anything out of range or
 * missing falls back to `UNJUDGED` so a truncated reply degrades to recall order
 * instead of emptying the result set.
 */
export function applyJudgements(candidates: Candidate[], judgements: Map<number, number>): Candidate[] {
  const scored = normalizeScores(candidates).map((candidate, index) => {
    const relevance = judgements.get(index) ?? UNJUDGED;
    return {
      candidate,
      relevance,
      blended:
        JUDGEMENT_WEIGHT * (relevance / MAX_RELEVANCE) + (1 - JUDGEMENT_WEIGHT) * candidate.score,
    };
  });

  return scored
    .filter((entry) => entry.relevance > 0)
    .sort((a, b) => b.blended - a.blended)
    .map((entry) => ({ ...entry.candidate, score: entry.blended }));
}

/**
 * Stage 4. Fusion ranks on lexical overlap and vector proximity, neither of which
 * knows what the question is asking; a model reading the question against each
 * candidate does. Items are addressed by position because the model reproduces a
 * small integer reliably and a UUID it does not.
 */
export async function rerankCandidates(
  query: string,
  candidates: Candidate[],
  deps: RetrievalDeps,
  config: RetrievalConfig,
): Promise<Candidate[]> {
  // A lone candidate is still worth judging: it is the case where an unrelated
  // hit would otherwise become the one thing an answer could cite.
  if (!config.rerank || candidates.length === 0) return normalizeScores(candidates);

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
      maxTokens: 1_500,
    });

    const judgements = new Map<number, number>();
    for (const { item, relevance } of reply.rankings ?? []) {
      if (!Number.isInteger(item) || item < 0 || item >= candidates.length) continue;
      judgements.set(item, Math.min(Math.max(relevance, 0), MAX_RELEVANCE));
    }
    return applyJudgements(candidates, judgements);
  } catch (error) {
    console.warn('rerank failed, keeping fusion order:', (error as Error).message);
    return normalizeScores(candidates);
  }
}
