import { describe, expect, it, vi } from 'vitest';
import { OWNER_ID } from '../../shared/contracts';
import type { Fact, PromiseMemory, Utterance } from '../../shared/contracts';
import { searchFacts, searchMemory } from './retrieval';
import type { PipelineStage, RetrievalDeps, StructuredRequest } from './types';

function fact(id: string, claim: string, overrides: Partial<Fact> = {}): Fact {
  return {
    _id: id,
    owner_id: OWNER_ID,
    person_id: 'sarah',
    attribute: 'coffee_order',
    claim,
    claim_normalized: claim.toLowerCase(),
    primary_source_utterance_id: `utt-${id}`,
    valid_from: '2026-08-01T00:00:00.000Z',
    created_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

/** The formulation a pipeline is searching for, wherever the stage happens to sit. */
function queryTextOf(pipeline: PipelineStage[]): string | undefined {
  const stages = pipeline.flatMap((stage) => {
    const fusion = (stage as { $rankFusion?: { input: { pipelines: Record<string, PipelineStage[]> } } }).$rankFusion;
    return fusion ? Object.values(fusion.input.pipelines).flat() : [stage];
  });
  for (const stage of stages) {
    const search = (stage as { $search?: { compound: { must: Array<{ text?: { query: string } }> } } }).$search;
    const text = search?.compound.must.find((clause) => clause.text)?.text;
    if (text) return text.query;
  }
  return undefined;
}

function hasLiveFilter(pipeline: PipelineStage[]): boolean {
  return JSON.stringify(pipeline).includes('superseded_by');
}

interface Harness {
  deps: RetrievalDeps;
  pipelines: PipelineStage[][];
  embedded: string[][];
}

function harness(options: {
  /** Facts each formulation retrieves, keyed by the text searched. */
  factsBy?: Record<string, Fact[]>;
  promises?: PromiseMemory[];
  utterances?: Utterance[];
  plan?: unknown;
  rerank?: unknown;
  planDelayMs?: number;
  onComplete?: (isRerank: boolean, user: string) => void;
  onAggregate?: (pipeline: PipelineStage[]) => void;
}): Harness {
  const pipelines: PipelineStage[][] = [];
  const embedded: string[][] = [];

  const deps: RetrievalDeps = {
    embedQueries: async (texts) => {
      embedded.push(texts);
      return texts.map(() => [0.1, 0.2]);
    },
    complete: async <T>(request: StructuredRequest) => {
      const isRerank = request.user.includes('Items:');
      const reply = isRerank ? options.rerank : options.plan;
      options.onComplete?.(isRerank, request.user);
      if (!isRerank && options.planDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.planDelayMs));
      }
      if (reply === undefined) throw new Error(isRerank ? 'no rerank stub' : 'no plan stub');
      return reply as T;
    },
    collections: {
      facts: {
        aggregate: (pipeline) => {
          pipelines.push(pipeline);
          options.onAggregate?.(pipeline);
          const text = queryTextOf(pipeline);
          return { toArray: async () => (text ? (options.factsBy?.[text] ?? []) : []) };
        },
      },
      promises: { find: () => ({ limit: () => ({ toArray: async () => options.promises ?? [] }) }) },
      utterances: { find: () => ({ limit: () => ({ toArray: async () => options.utterances ?? [] }) }) },
    },
  };

  return { deps, pipelines, embedded };
}

const NO_LLM = { plan: false, rerank: false };
/** Planning is off by default; the tests that exercise stage 1 ask for it. */
const PLANNED = { plan: true };

describe('searchMemory', () => {
  it('surfaces a fact only the planner\'s vocabulary could reach', async () => {
    const { deps, embedded } = harness({
      factsBy: {
        "what's Sarah's usual": [],
        'sarah oat milk latte': [fact('f-latte', 'Sarah drinks oat milk lattes')],
      },
      plan: { variants: ['sarah oat milk latte'], hypothetical: '' },
      rerank: { rankings: [{ item: 0, relevance: 3 }] },
    });

    const results = await searchMemory("what's Sarah's usual", undefined, { deps, config: PLANNED });

    expect(results.map((result) => result.id)).toEqual(['f-latte']);
    expect(results[0]).toMatchObject({ kind: 'fact', person_id: 'sarah', source_utterance_id: 'utt-f-latte' });
    // Every formulation shares one embedding request.
    expect(embedded).toEqual([["what's Sarah's usual", 'sarah oat milk latte']]);
  });

  it('searches the hypothetical answer alongside the question', async () => {
    const { deps } = harness({
      factsBy: { 'Sarah drinks oat milk lattes.': [fact('f-hyde', 'Sarah drinks oat milk lattes')] },
      plan: { variants: [], hypothetical: 'Sarah drinks oat milk lattes.' },
      rerank: { rankings: [{ item: 0, relevance: 2 }] },
    });

    const results = await searchMemory('what does Sarah drink', undefined, { deps, config: PLANNED });
    expect(results.map((result) => result.id)).toEqual(['f-hyde']);
  });

  it('ranks a fact both formulations found above one only a paraphrase found', async () => {
    const agreed = fact('f-agreed', 'Sarah drinks oat milk lattes');
    const single = fact('f-single', 'Sarah once tried cold brew', { _id: 'f-single' });
    const { deps } = harness({
      factsBy: {
        'what does Sarah drink': [agreed],
        'sarah coffee': [single, agreed],
      },
      plan: { variants: ['sarah coffee'], hypothetical: '' },
      rerank: { rankings: [{ item: 0, relevance: 2 }, { item: 1, relevance: 2 }] },
    });

    const results = await searchMemory('what does Sarah drink', undefined, { deps, config: PLANNED });
    expect(results.map((result) => result.id)).toEqual(['f-agreed', 'f-single']);
  });

  it('filters superseded claims in every fact pipeline it sends', async () => {
    const seen: boolean[] = [];
    const { deps } = harness({
      factsBy: { q: [] },
      plan: { variants: ['other'], hypothetical: 'hyde' },
      rerank: { rankings: [] },
      onAggregate: (pipeline) => seen.push(hasLiveFilter(pipeline)),
    });

    await searchMemory('q', undefined, { deps, config: PLANNED });

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(Boolean)).toBe(true);
  });

  it('includes promises and utterances, and caps them below facts by default', async () => {
    const { deps } = harness({
      factsBy: { 'what about the deck': [fact('f1', 'Sarah drinks lattes')] },
      promises: [
        {
          _id: 'p1',
          owner_id: OWNER_ID,
          person_id: 'sarah',
          source_utterance_id: 'utt-p1',
          text: 'Sarah will send the deck',
          text_normalized: 'sarah will send the deck',
          status: 'open',
          created_at: '2026-08-02T00:00:00.000Z',
        },
      ],
      plan: { variants: [], hypothetical: '' },
      rerank: { rankings: [{ item: 0, relevance: 2 }, { item: 1, relevance: 2 }] },
    });

    const results = await searchMemory('what about the deck', undefined, { deps });
    expect(results.map((result) => result.kind)).toEqual(['fact', 'promise']);
  });

  it('spends exactly two inference requests: one plan, one rerank', async () => {
    const shared = fact('f-shared', 'Maya moves to Oakland on September 15');
    const calls: string[] = [];
    const { deps, embedded } = harness({
      factsBy: { 'when is Maya moving': [shared], 'maya move date': [shared] },
      plan: { variants: ['maya move date'], hypothetical: '' },
      rerank: { rankings: [{ item: 0, relevance: 3 }] },
      onComplete: (isRerank) => calls.push(isRerank ? 'rerank' : 'plan'),
    });

    const results = await searchMemory('when is Maya moving', undefined, { deps, config: PLANNED });

    expect(calls).toEqual(['plan', 'rerank']);
    // And one embedding request covering every formulation.
    expect(embedded).toEqual([['when is Maya moving', 'maya move date']]);
    expect(results.map((result) => result.id)).toEqual(['f-shared']);
  });

  it('abandons a planner that outlasts its deadline', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { deps, embedded } = harness({
      factsBy: { 'what does Sarah drink': [fact('f1', 'Sarah drinks lattes')] },
      plan: { variants: ['never arrives'], hypothetical: '' },
      rerank: { rankings: [{ item: 0, relevance: 3 }] },
      planDelayMs: 50,
    });

    const results = await searchMemory('what does Sarah drink', undefined, {
      deps,
      config: { plan: true, planDeadlineMs: 1 },
    });

    // The expansion is lost; the question itself is still searched.
    expect(embedded).toEqual([['what does Sarah drink']]);
    expect(results.map((result) => result.id)).toEqual(['f1']);
    warn.mockRestore();
  });

  it('degrades to the raw question when planning fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { deps } = harness({
      factsBy: { 'what does Sarah drink': [fact('f1', 'Sarah drinks lattes')] },
      rerank: { rankings: [{ item: 0, relevance: 3 }] },
    });

    const results = await searchMemory('what does Sarah drink', undefined, { deps, config: PLANNED });

    expect(results.map((result) => result.id)).toEqual(['f1']);
    warn.mockRestore();
  });

  it('falls back to hand-rolled RRF when the cluster rejects $rankFusion', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let rejected = false;
    const { deps, pipelines } = harness({
      factsBy: { q: [fact('f1', 'Sarah drinks lattes')] },
      onAggregate: (pipeline) => {
        if (pipeline[0] && '$rankFusion' in pipeline[0]) {
          rejected = true;
          throw new Error('Unrecognized pipeline stage name: $rankFusion');
        }
      },
    });

    const results = await searchMemory('q', undefined, { deps, config: NO_LLM });

    expect(rejected).toBe(true);
    // Two separate legs replace the single fused pipeline.
    expect(pipelines.filter((pipeline) => '$vectorSearch' in pipeline[0]!)).toHaveLength(1);
    expect(results.map((result) => result.id)).toEqual(['f1']);
    warn.mockRestore();
  });

  it('honours the person filter on every leg', async () => {
    const { deps, pipelines } = harness({ factsBy: { q: [] } });

    await searchMemory('q', 'sarah', { deps, config: NO_LLM });

    expect(pipelines.every((pipeline) => JSON.stringify(pipeline).includes('"person_id":"sarah"'))).toBe(true);
  });

  it('returns nothing rather than filler when the reranker rejects the pool', async () => {
    const { deps } = harness({
      factsBy: { q: [fact('f1', 'Sarah drinks lattes')] },
      plan: { variants: [], hypothetical: '' },
      rerank: { rankings: [{ item: 0, relevance: 0 }] },
    });

    expect(await searchMemory('q', undefined, { deps })).toEqual([]);
  });

  it('applies the diversity cap after reranking', async () => {
    const crowded = ['a', 'b', 'c'].map((id) => fact(`f-${id}`, `Sarah drinks ${id}`));
    const { deps } = harness({
      factsBy: { q: [...crowded, fact('f-job', 'Sarah works at Acme', { attribute: 'employer' })] },
      plan: { variants: [], hypothetical: '' },
      rerank: { rankings: [0, 1, 2, 3].map((item) => ({ item, relevance: 2 })) },
    });

    const results = await searchMemory('q', undefined, { deps, config: { limit: 3 } });
    expect(results.map((result) => result.id)).toEqual(['f-a', 'f-b', 'f-job']);
  });
});

describe('searchFacts', () => {
  it('never reaches for promises or utterances', async () => {
    let scanned = false;
    const deps = harness({ factsBy: { q: [fact('f1', 'Sarah drinks lattes')] } }).deps;
    deps.collections.promises = {
      find: () => {
        scanned = true;
        return { limit: () => ({ toArray: async () => [] }) };
      },
    };

    const results = await searchFacts('q', undefined, { deps, config: NO_LLM });

    expect(scanned).toBe(false);
    expect(results.map((result) => result.kind)).toEqual(['fact']);
  });
});
