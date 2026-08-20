import { describe, expect, it } from 'vitest';
import { bm25, cosine, fuseByRank, semanticScores, tokenize, topN } from './scoring';

const docs = [
  { id: 'a', text: 'Tarun asked when the transit app and the buses start' },
  { id: 'b', text: 'Josh has had a sinus infection for three months' },
  { id: 'c', text: 'I need to download Luma now that I have wifi' },
  { id: 'd', text: 'the app is free' },
];

describe('tokenize', () => {
  it('drops stop words but keeps short meaningful terms', () => {
    expect(tokenize('I have an 8am class and a job at the gym')).toEqual([
      '8am',
      'class',
      'job',
      'gym',
    ]);
  });

  it('splits on punctuation without losing apostrophes inside words', () => {
    expect(tokenize("Josh's cough drops.")).toEqual(["josh's", 'cough', 'drops']);
  });

  it('returns nothing for a query that is entirely stop words', () => {
    expect(tokenize('what is it about')).toEqual([]);
  });
});

describe('bm25', () => {
  it('ranks the document about the query above one that merely shares a common word', () => {
    const scores = bm25('transit app', docs);
    const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
    expect(ranked[0][0]).toBe('a');
  });

  it('rewards a rare term over a frequent one', () => {
    const scores = bm25('app sinus', docs);
    expect(scores.get('b')).toBeGreaterThan(scores.get('d') ?? 0);
  });

  it('scores nothing when no query term appears', () => {
    expect(bm25('stargazing', docs).size).toBe(0);
  });

  it('is empty for an all-stop-word query rather than matching everything', () => {
    expect(bm25('what is it', docs).size).toBe(0);
  });

  it('handles an empty corpus', () => {
    expect(bm25('anything', []).size).toBe(0);
  });
});

describe('cosine', () => {
  it('is 1 for identical direction and 0 for orthogonal', () => {
    expect(cosine([1, 0], [2, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('is invariant to scale', () => {
    expect(cosine([3, 4], [6, 8])).toBeCloseTo(1);
  });

  it('returns 0 rather than NaN for a zero vector', () => {
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
});

describe('semanticScores', () => {
  it('skips documents with no embedding instead of scoring them zero-but-present', () => {
    const scored = semanticScores([1, 0], [
      { id: 'a', text: 'x', embedding: [1, 0] },
      { id: 'b', text: 'y' },
    ]);
    expect([...scored.keys()]).toEqual(['a']);
  });

  it('is empty when the query could not be embedded', () => {
    expect(semanticScores(undefined, [{ id: 'a', text: 'x', embedding: [1, 0] }]).size).toBe(0);
  });

  it('leaves out documents that are merely the least unrelated', () => {
    // Cosine always answers, so without a floor every document is a hit and
    // rank fusion promotes the nearest of them however far away it is.
    const scored = semanticScores(
      [1, 0],
      [
        { id: 'near', text: 'x', embedding: [0.99, 0.14] },
        { id: 'far', text: 'y', embedding: [0.2, 0.98] },
      ],
    );
    expect([...scored.keys()]).toEqual(['near']);
  });

  it('takes the floor from the caller when one is given', () => {
    const documents = [{ id: 'a', text: 'x', embedding: [0.8, 0.6] }];
    expect(semanticScores([1, 0], documents, 0.9).size).toBe(0);
    expect(semanticScores([1, 0], documents, 0.5).size).toBe(1);
  });
});

describe('fuseByRank', () => {
  it('puts a document ranked well by both legs above one ranked well by only one', () => {
    const lexical = new Map([['a', 10], ['b', 1]]);
    const semantic = new Map([['a', 0.9], ['c', 0.8]]);
    const fused = fuseByRank([lexical, semantic]);
    expect(fused.get('a')).toBeGreaterThan(fused.get('c') ?? 0);
    expect(fused.get('a')).toBeGreaterThan(fused.get('b') ?? 0);
  });

  it('fuses by rank, not by raw score magnitude', () => {
    // BM25 scores are unbounded and cosines are not; the loser here wins on
    // magnitude alone and must still lose on rank.
    const lexical = new Map([['a', 1000], ['b', 999]]);
    const semantic = new Map([['b', 0.9], ['a', 0.1]]);
    const fused = fuseByRank([lexical, semantic]);
    expect(fused.get('a')).toBeCloseTo(fused.get('b') ?? 0, 5);
  });
});

describe('topN', () => {
  it('orders by score, drops unscored documents, and respects the limit', () => {
    const scores = new Map([['a', 0.2], ['c', 0.9]]);
    const result = topN(docs, scores, 5);
    expect(result.map((entry) => entry.document.id)).toEqual(['c', 'a']);
  });

  it('truncates to the limit', () => {
    const scores = new Map([['a', 3], ['b', 2], ['c', 1]]);
    expect(topN(docs, scores, 2)).toHaveLength(2);
  });
});
