import { describe, expect, it } from 'vitest';
import { capPerAttribute, fuseCandidates, normalizeScores, RRF_K } from './fusion';
import type { Candidate } from './types';

function candidate(id: string, overrides: Partial<Candidate> = {}): Candidate {
  return { id, kind: 'fact', text: `claim ${id}`, score: 0, ...overrides };
}

describe('fuseCandidates', () => {
  it('rewards agreement between rankings over a single strong hit', () => {
    const fused = fuseCandidates([
      { weight: 1, items: [candidate('alone'), candidate('shared')] },
      { weight: 1, items: [candidate('shared'), candidate('other')] },
    ]);

    expect(fused.map((entry) => entry.id)).toEqual(['shared', 'alone', 'other']);
    expect(fused[0]!.score).toBeCloseTo(1 / (RRF_K + 2) + 1 / (RRF_K + 1));
  });

  it('scales each ranking by how much the formulation is trusted', () => {
    const fused = fuseCandidates([
      { weight: 0.7, items: [candidate('paraphrase')] },
      { weight: 1, items: [candidate('original')] },
    ]);

    expect(fused.map((entry) => entry.id)).toEqual(['original', 'paraphrase']);
  });

  it('keeps the fullest copy of a candidate seen by several legs', () => {
    const fused = fuseCandidates([
      { weight: 1, items: [candidate('a', { attribute: 'coffee_order' })] },
      { weight: 1, items: [candidate('a')] },
    ]);

    expect(fused).toHaveLength(1);
    expect(fused[0]!.attribute).toBe('coffee_order');
  });
});

describe('normalizeScores', () => {
  it('rescales to 0..1 against the top hit', () => {
    const scored = normalizeScores([candidate('a', { score: 0.04 }), candidate('b', { score: 0.01 })]);
    expect(scored.map((entry) => entry.score)).toEqual([1, 0.25]);
  });

  it('survives an all-zero ranking without dividing by zero', () => {
    expect(normalizeScores([candidate('a')])[0]!.score).toBe(0);
  });
});

describe('capPerAttribute', () => {
  const crowded = [
    candidate('c1', { person_id: 'p1', attribute: 'coffee_order' }),
    candidate('c2', { person_id: 'p1', attribute: 'coffee_order' }),
    candidate('c3', { person_id: 'p1', attribute: 'coffee_order' }),
    candidate('j1', { person_id: 'p1', attribute: 'job' }),
  ];

  it('pushes overflow past the cap to the tail instead of dropping it', () => {
    expect(capPerAttribute(crowded, 2).map((entry) => entry.id)).toEqual(['c1', 'c2', 'j1', 'c3']);
  });

  it('counts each person separately', () => {
    const twoPeople = [
      candidate('a', { person_id: 'p1', attribute: 'job' }),
      candidate('b', { person_id: 'p2', attribute: 'job' }),
    ];
    expect(capPerAttribute(twoPeople, 1).map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  it('leaves promises and utterances alone', () => {
    const mixed = [
      candidate('u1', { kind: 'utterance' }),
      candidate('u2', { kind: 'utterance' }),
      candidate('p1', { kind: 'promise' }),
    ];
    expect(capPerAttribute(mixed, 1)).toEqual(mixed);
  });
});
