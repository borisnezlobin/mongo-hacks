import { describe, expect, it } from 'vitest';
import type { Fact, Person, PromiseMemory, Utterance } from '../../shared/contracts';
import { OWNER_ID } from '../../shared/contracts';
import { buildContextChangeGraph } from './changes';

const person = (id: string, name: string): Person => ({
  _id: id, owner_id: OWNER_ID, name, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
});
const utterance = (id: string, conversation: string, personId: string, end: number): Utterance => ({
  _id: id, owner_id: OWNER_ID, conversation_id: conversation, person_id: personId,
  text: id, start_ms: end - 100, end_ms: end, is_final: true,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
});

describe('MongoDB context change graph', () => {
  it('derives lineage, possible ripple, and absent prior participants', () => {
    const before: Fact = {
      _id: 'old', owner_id: OWNER_ID, person_id: 'maya', attribute: 'move_date', claim: 'Maya moves September 15',
      claim_normalized: 'maya moves september 15', primary_source_utterance_id: 'old-source',
      valid_from: '2026-08-01T00:00:00Z', created_at: '2026-08-01T00:00:00Z', superseded_by: 'new',
    };
    const after: Fact = {
      _id: 'new', owner_id: OWNER_ID, person_id: 'maya', attribute: 'move_date', claim: 'Maya moves September 20',
      claim_normalized: 'maya moves september 20', primary_source_utterance_id: 'new-source',
      valid_from: '2026-08-13T00:00:00Z', created_at: '2026-08-13T00:00:00Z',
    };
    const promise: PromiseMemory = {
      _id: 'loop', owner_id: OWNER_ID, person_id: 'owner', source_utterance_id: 'promise-source',
      text: 'Help Maya pack before she moves', text_normalized: 'help maya pack before she moves',
      status: 'open', created_at: '2026-08-01T00:00:00Z',
    };

    const [change] = buildContextChangeGraph({
      previousFacts: [before], currentFacts: [after], promises: [promise],
      people: [person('owner', 'Yan'), person('maya', 'Maya'), person('jules', 'Jules')],
      utterances: [
        utterance('old-owner', 'old-room', 'owner', 100),
        utterance('old-jules', 'old-room', 'jules', 200),
        utterance('old-source', 'old-room', 'maya', 300),
        utterance('new-owner', 'new-room', 'owner', 100),
        utterance('new-source', 'new-room', 'maya', 200),
      ],
    });

    expect(change.recorded_with.map((item) => item.name)).toEqual(['Yan', 'Maya']);
    expect(change.may_have_missed.map((item) => item.name)).toEqual(['Jules']);
    expect(change.affected_promises).toEqual([expect.objectContaining({ _id: 'loop' })]);
  });
});
