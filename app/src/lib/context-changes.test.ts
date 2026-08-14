import { describe, expect, it } from 'vitest';
import { applyEvents, createInitialState } from './store';
import { deriveContextChanges } from './context-changes';
import { mockScript } from './mock-sse';

describe('context change read model', () => {
  it('connects a replacement to its source, downstream loops, and recorded context gap', () => {
    const state = applyEvents(createInitialState(), mockScript.map((item) => item.event));
    const change = deriveContextChanges(state).find((item) => item.id === 'f-maya-move-3');

    expect(change).toMatchObject({
      person_name: 'Maya',
      attribute: 'move_date',
      before: { claim: 'Moving to Oakland on September 15' },
      after: { claim: 'Moving to Oakland on September 20' },
      source_utterance_id: 'lu2',
    });
    expect(change?.affected_promises.map((promise) => promise._id)).toContain('pr-owner-oakland');
    expect(change?.recorded_with.map((person) => person.name)).toEqual(['Yan', 'Maya']);
    expect(change?.may_have_missed.map((person) => person.name)).toEqual(expect.arrayContaining(['Jules', 'Priya']));
  });

  it('never labels the person making the correction as missing it', () => {
    const state = applyEvents(createInitialState(), mockScript.map((item) => item.event));
    const change = deriveContextChanges(state).find((item) => item.id === 'f-maya-move-3');
    expect(change?.may_have_missed.map((person) => person.name)).not.toContain('Maya');
  });
});
