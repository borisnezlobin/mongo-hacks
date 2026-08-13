import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Fact, Utterance } from '../../shared/contracts';

const mocks = vi.hoisted(() => ({
  extractStructured: vi.fn(),
  findFactBySourceClaim: vi.fn(),
  getPerson: vi.fn(),
  recordFact: vi.fn(),
  recordPromise: vi.fn(),
  resolveFactState: vi.fn(),
  utteranceFindOne: vi.fn(),
  utterances: [] as Utterance[],
}));

vi.mock('./llm', () => ({ extractStructured: mocks.extractStructured }));
vi.mock('./store', () => ({
  findFactBySourceClaim: mocks.findFactBySourceClaim,
  getPerson: mocks.getPerson,
  recordFact: mocks.recordFact,
  recordPromise: mocks.recordPromise,
  resolveFactState: mocks.resolveFactState,
}));
vi.mock('./db', () => ({
  collections: {
    utterances: () => ({
      find: () => ({ sort: () => ({ toArray: async () => mocks.utterances }) }),
      findOne: mocks.utteranceFindOne,
    }),
  },
}));

import { runFastPass } from './passes';

const turn: Utterance = {
  _id: 'u-change',
  owner_id: 'owner',
  conversation_id: 'c-live',
  person_id: 'p-maya',
  text: 'Actually my move date changed to September twentieth.',
  start_ms: 1000,
  end_ms: 3000,
  is_final: true,
  created_at: '2026-08-13T00:00:00Z',
  updated_at: '2026-08-13T00:00:00Z',
};

const current: Fact = {
  _id: 'f-old',
  owner_id: 'owner',
  person_id: 'p-maya',
  attribute: 'move',
  claim: 'Maya moves on September 15.',
  claim_normalized: 'maya moves on september 15',
  primary_source_utterance_id: 'u-old',
  valid_from: '2026-08-12T00:00:00Z',
  created_at: '2026-08-12T00:00:00Z',
};

describe('per-turn fact reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.utterances = [turn];
    mocks.getPerson.mockResolvedValue({ name: 'Maya' });
    mocks.findFactBySourceClaim.mockResolvedValue(null);
    mocks.resolveFactState.mockResolvedValue(current);
    mocks.utteranceFindOne.mockImplementation(async ({ _id }: { _id: string }) => (
      _id === turn._id ? turn : { ...turn, _id: 'u-old', start_ms: 0, end_ms: 500 }
    ));
    mocks.extractStructured
      .mockResolvedValueOnce({
        promises: [],
        facts: [{
          person_id: 'p-maya',
          attribute: 'move',
          claim: 'Maya moves on September 20.',
          primary_source_utterance_id: turn._id,
        }],
      })
      .mockResolvedValueOnce({ relation: 'replace', reason: 'The move date changed.' });
  });

  it('supersedes current state during the finalized turn fast pass', async () => {
    await runFastPass({ emit: vi.fn(), subscribe: vi.fn() } as never, turn);

    expect(mocks.recordFact).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      person_id: 'p-maya',
      attribute: 'move',
      supersedes: 'f-old',
    }));
  });

  it('ignores a model-produced person id that was not present in the labelled window', async () => {
    mocks.extractStructured.mockReset().mockResolvedValueOnce({
      promises: [],
      facts: [{
        person_id: 'p-invented',
        attribute: 'move',
        claim: 'An invented person moved.',
        primary_source_utterance_id: turn._id,
      }],
    });

    await runFastPass({ emit: vi.fn(), subscribe: vi.fn() } as never, turn);

    expect(mocks.recordFact).not.toHaveBeenCalled();
    expect(mocks.resolveFactState).not.toHaveBeenCalled();
  });
});
