import { describe, expect, it, vi } from 'vitest';
import { retrievalConfig } from './config';
import { keywordsFrom, planQuery } from './query-plan';
import type { RetrievalDeps } from './types';

function deps(complete: RetrievalDeps['complete']): RetrievalDeps {
  return {
    complete,
    embedQueries: async () => [],
    collections: {
      facts: { aggregate: () => ({ toArray: async () => [] }) },
      promises: { find: () => ({ limit: () => ({ toArray: async () => [] }) }) },
      utterances: { find: () => ({ limit: () => ({ toArray: async () => [] }) }) },
    },
  };
}

const config = retrievalConfig({ plan: true, maxVariants: 3 });

describe('keywordsFrom', () => {
  it('keeps content words and drops question scaffolding', () => {
    expect(keywordsFrom('What did Sarah say about the conference?')).toEqual(['sarah', 'conference']);
  });

  it('deduplicates', () => {
    expect(keywordsFrom('sarah sarah Sarah')).toEqual(['sarah']);
  });
});

describe('planQuery', () => {
  it('keeps variants, the hypothetical answer, and keywords', async () => {
    const complete = vi.fn(async () => ({
      variants: ['what does sarah drink', 'sarah coffee preference'],
      hypothetical: 'Sarah drinks oat milk lattes.',
      keywords: ['Sarah', 'coffee'],
    }));

    const plan = await planQuery("what's Sarah's coffee order", deps(complete as never), config);

    expect(plan.variants).toEqual(['what does sarah drink', 'sarah coffee preference']);
    expect(plan.hypothetical).toBe('Sarah drinks oat milk lattes.');
    expect(plan.keywords).toEqual(['sarah', 'coffee']);
  });

  it('drops a variant that only restates the question', async () => {
    const complete = vi.fn(async () => ({
      variants: ['Where does Ben live?', 'ben address'],
      hypothetical: '',
      keywords: [],
    }));

    const plan = await planQuery('Where does Ben live?', deps(complete as never), config);

    expect(plan.variants).toEqual(['ben address']);
    // An empty hypothetical is dropped rather than searched as a blank query.
    expect(plan.hypothetical).toBeUndefined();
    // Nothing usable came back, so the local extraction stands in.
    expect(plan.keywords).toEqual(['ben', 'live']);
  });

  it('honours the variant cap', async () => {
    const complete = vi.fn(async () => ({
      variants: ['a one', 'b two', 'c three', 'd four'],
      hypothetical: 'x',
      keywords: ['k'],
    }));

    const plan = await planQuery('q', deps(complete as never), retrievalConfig({ plan: true, maxVariants: 2 }));
    expect(plan.variants).toHaveLength(2);
  });

  it('falls back to the raw question when the planner fails', async () => {
    const complete = vi.fn(async () => {
      throw new Error('inference down');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const plan = await planQuery('what did Sarah promise', deps(complete as never), config);

    expect(plan).toEqual({ original: 'what did Sarah promise', variants: [], keywords: ['sarah', 'promise'] });
    warn.mockRestore();
  });

  it('does not call the model when planning is switched off', async () => {
    const complete = vi.fn();
    const plan = await planQuery('anything', deps(complete as never), retrievalConfig({ plan: false }));

    expect(complete).not.toHaveBeenCalled();
    expect(plan.variants).toEqual([]);
  });
});
