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
  /** Content words for the lexical leg and the promise/utterance scan. */
  keywords: string[];
}

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['variants', 'hypothetical', 'keywords'],
  properties: {
    variants: { type: 'array', items: { type: 'string' }, maxItems: 4 },
    hypothetical: { type: 'string' },
    keywords: { type: 'array', items: { type: 'string' }, maxItems: 8 },
  },
} as const;

const PLAN_SYSTEM = `You prepare search queries against a personal memory of real conversations.

The memory stores short declarative claims about people, each keyed by an attribute,
for example attribute "coffee_order" with the claim "Sarah drinks oat milk lattes".
It also stores promises someone made and raw transcript lines.

Given a question, return:
- variants: up to three alternative phrasings or narrower sub-questions. Use the
  vocabulary a speaker would actually use out loud, not the vocabulary of the
  question. Do not restate the question verbatim.
- hypothetical: one short declarative sentence that would answer the question if
  it were in the memory. Invent plausible specifics; it is used only as a search
  vector and is never shown to anyone.
- keywords: the content words worth matching literally, lowercase, no pronouns,
  no question words, no filler.

Return nothing else. If the question is already minimal, return fewer variants.`;

const STOPWORDS = new Set([
  'what', 'when', 'where', 'which', 'who', 'whom', 'whose', 'does', 'did', 'do', 'is', 'are',
  'was', 'were', 'the', 'that', 'this', 'they', 'them', 'their', 'about', 'with', 'from',
  'have', 'has', 'had', 'been', 'said', 'say', 'says', 'tell', 'told', 'know', 'anything',
  'something', 'again', 'there', 'here', 'into', 'over', 'like', 'just', 'much', 'many',
]);

/** Content words only, so the lexical leg is not dominated by question scaffolding. */
export function keywordsFrom(query: string): string[] {
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}'-]+/u)
    // Three characters keeps short first names, the sharpest lexical signal there is.
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word));
  return [...new Set(words)];
}

export function fallbackPlan(query: string): QueryPlan {
  return { original: query, variants: [], keywords: keywordsFrom(query) };
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
    const reply = await deps.complete<{ variants: string[]; hypothetical: string; keywords: string[] }>({
      system: PLAN_SYSTEM,
      user: `Question: ${query}`,
      schema: PLAN_SCHEMA,
      maxTokens: 500,
    });

    const original = query.trim().toLowerCase();
    const variants = clean(reply.variants, config.maxVariants).filter(
      (variant) => variant.toLowerCase() !== original,
    );
    const hypothetical = typeof reply.hypothetical === 'string' ? reply.hypothetical.trim() : '';
    const keywords = clean(reply.keywords, 8).map((keyword) => keyword.toLowerCase());

    return {
      original: query,
      variants,
      hypothetical: hypothetical || undefined,
      // The planner can return nothing usable while still returning valid JSON.
      keywords: keywords.length > 0 ? keywords : keywordsFrom(query),
    };
  } catch (error) {
    console.warn('query planning failed, searching the raw question:', (error as Error).message);
    return fallbackPlan(query);
  }
}
