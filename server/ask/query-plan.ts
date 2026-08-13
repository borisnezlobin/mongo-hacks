import type { RetrievalConfig } from './config';
import type { RetrievalDeps } from './types';

export interface QueryPlan {
  original: string;
  /** Paraphrases and sub-questions embedded alongside the original. */
  variants: string[];
  /**
   * A short invented claim that would answer the question. Stored facts are
   * declarative ("Sarah drinks oat milk lattes") while queries are interrogative
   * ("what does Sarah drink"), and the two sit in different parts of the
   * embedding space. Searching with a hypothetical answer closes that gap.
   */
  hypothetical?: string;
}

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['variants', 'hypothetical'],
  properties: {
    variants: { type: 'array', items: { type: 'string' }, maxItems: 4 },
    hypothetical: { type: 'string' },
  },
} as const;

/**
 * Deliberately terse. This call is on the interactive path, and every extra
 * instruction buys reasoning tokens the asker waits on. Rewriting a question is
 * not a task the model needs talked through.
 */
const PLAN_SYSTEM = `Rewrite a question for search over a memory of spoken conversations.
The memory holds short declarative claims about people ("Sarah drinks oat milk lattes"),
promises, and transcript lines.

variants: up to three rephrasings in the words a speaker would use out loud. Never the question verbatim.
hypothetical: one short declarative sentence that would answer the question. Invent specifics; it is only a search vector.

Answer immediately. Do not deliberate.`;

const STOPWORDS = new Set([
  'what', 'when', 'where', 'which', 'who', 'whom', 'whose', 'does', 'did', 'do', 'is', 'are',
  'was', 'were', 'the', 'that', 'this', 'they', 'them', 'their', 'about', 'with', 'from',
  'have', 'has', 'had', 'been', 'said', 'say', 'says', 'tell', 'told', 'know', 'anything',
  'something', 'again', 'there', 'here', 'into', 'over', 'like', 'just', 'much', 'many',
]);

/**
 * Content words only, so the keyword scan is not dominated by question
 * scaffolding. Derived locally rather than asked of the planner: it costs
 * nothing, and it keeps the scan independent of an inference request.
 */
export function keywordsFrom(query: string): string[] {
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}'-]+/u)
    // Three characters keeps short first names, the sharpest lexical signal there is.
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word));
  return [...new Set(words)];
}

export function fallbackPlan(query: string): QueryPlan {
  return { original: query, variants: [] };
}

function clean(values: unknown, limit: number): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    kept.push(trimmed);
    if (kept.length === limit) break;
  }
  return kept;
}

/**
 * Stage 1. One question is one sample of what the asker meant; several
 * formulations cover more of the embedding space than any single one does.
 * A planner failure is never fatal — the raw question is always a valid plan.
 */
export async function planQuery(
  query: string,
  deps: RetrievalDeps,
  config: RetrievalConfig,
): Promise<QueryPlan> {
  if (!config.plan) return fallbackPlan(query);

  try {
    const reply = await deps.complete<{ variants: string[]; hypothetical: string }>({
      system: PLAN_SYSTEM,
      user: `Question: ${query}`,
      schema: PLAN_SCHEMA,
      maxTokens: 400,
      reasoningEffort: 'low',
    });

    const original = query.trim().toLowerCase();
    const variants = clean(reply.variants, config.maxVariants).filter(
      (variant) => variant.toLowerCase() !== original,
    );
    const hypothetical = typeof reply.hypothetical === 'string' ? reply.hypothetical.trim() : '';

    return { original: query, variants, hypothetical: hypothetical || undefined };
  } catch (error) {
    console.warn('query planning failed, searching the raw question:', (error as Error).message);
    return fallbackPlan(query);
  }
}
