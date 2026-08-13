import { describe, expect, it } from 'vitest';
import type { SearchMemoryResult } from '../../shared/contracts';
import { preferResolvedState } from './index';

const fact: SearchMemoryResult = {
  kind: 'fact',
  id: 'f-current',
  person_id: 'p-maya',
  text: 'Maya moves on September 20.',
  score: 1,
  source_utterance_id: 'u-new',
};

const staleUtterance: SearchMemoryResult = {
  kind: 'utterance',
  id: 'u-old',
  person_id: 'p-maya',
  text: 'I move on September 1.',
  score: 0.25,
  source_utterance_id: 'u-old',
};

describe('resolved answer context', () => {
  it('does not let historical utterances compete with a current fact', () => {
    expect(preferResolvedState([fact, staleUtterance])).toEqual([fact]);
  });

  it('keeps utterances when no structured current fact was found', () => {
    expect(preferResolvedState([staleUtterance])).toEqual([staleUtterance]);
  });
});
