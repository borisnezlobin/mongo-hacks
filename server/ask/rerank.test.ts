import { describe, expect, it, vi } from 'vitest';
import { retrievalConfig } from './config';
import { applyJudgements, rerankCandidates } from './rerank';
import type { Candidate, RetrievalDeps, StructuredRequest } from './types';

function candidate(id: string, score: number, overrides: Partial<Candidate> = {}): Candidate {
  return { id, kind: 'fact', text: `claim ${id}`, score, ...overrides };
}

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

const config = retrievalConfig({ rerank: true });

describe('applyJudgements', () => {
  const pool = [candidate('top', 0.9), candidate('middle', 0.5), candidate('bottom', 0.1)];

  it('lets the judgement override recall order', () => {
    const ranked = applyJudgements(pool, new Map([[0, 1], [1, 1], [2, 3]]));
    expect(ranked.map((entry) => entry.id)).toEqual(['bottom', 'top', 'middle']);
  });

  it('breaks ties on recall order', () => {
    const ranked = applyJudgements(pool, new Map([[0, 2], [1, 2], [2, 2]]));
    expect(ranked.map((entry) => entry.id)).toEqual(['top', 'middle', 'bottom']);
  });

  it('drops items judged irrelevant', () => {
    const ranked = applyJudgements(pool, new Map([[0, 0], [1, 3], [2, 0]]));
    expect(ranked.map((entry) => entry.id)).toEqual(['middle']);
  });

  it('treats an unjudged item as weakly relevant rather than rejected', () => {
    const ranked = applyJudgements(pool, new Map([[0, 3]]));
    expect(ranked.map((entry) => entry.id)).toEqual(['top', 'middle', 'bottom']);
  });

  it('reports scores on a 0..1 scale', () => {
    const ranked = applyJudgements(pool, new Map([[0, 3], [1, 3], [2, 3]]));
    expect(ranked[0]!.score).toBeCloseTo(1);
    expect(ranked.every((entry) => entry.score >= 0 && entry.score <= 1)).toBe(true);
  });
});

describe('rerankCandidates', () => {
  const pool = [candidate('a', 0.9), candidate('b', 0.5)];

  it('addresses candidates by position and applies what came back', async () => {
    let prompt = '';
    const complete = vi.fn(async (request: StructuredRequest) => {
      prompt = request.user;
      return { rankings: [{ item: 0, relevance: 0 }, { item: 1, relevance: 3 }] };
    });
    const ranked = await rerankCandidates('question', pool, deps(complete as never), config);

    expect(ranked.map((entry) => entry.id)).toEqual(['b']);
    expect(prompt).toContain('[0]');
  });

  it('ignores positions the model invented', async () => {
    const complete = vi.fn(async () => ({ rankings: [{ item: 42, relevance: 3 }, { item: -1, relevance: 3 }] }));
    const ranked = await rerankCandidates('question', pool, deps(complete as never), config);

    expect(ranked.map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  it('keeps fusion order when the model fails', async () => {
    const complete = vi.fn(async () => {
      throw new Error('inference down');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const ranked = await rerankCandidates('question', pool, deps(complete as never), config);

    expect(ranked.map((entry) => entry.id)).toEqual(['a', 'b']);
    warn.mockRestore();
  });

  it('does not call the model when reranking is switched off', async () => {
    const complete = vi.fn();
    const ranked = await rerankCandidates('q', pool, deps(complete as never), retrievalConfig({ rerank: false }));

    expect(complete).not.toHaveBeenCalled();
    expect(ranked.map((entry) => entry.id)).toEqual(['a', 'b']);
  });
});
