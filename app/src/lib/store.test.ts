import { describe, expect, it } from 'vitest';
import type { AmeliaEvent } from '../../../shared/contracts';
import { mockScript, LIVE_CONVERSATION_ID } from './mock-sse';
import { applyEvents, createInitialState, isUnnamed } from './store';
import { UNKNOWN_PERSON_ID } from './seed';

const scriptEvents: AmeliaEvent[] = mockScript.map((item) => item.event);

describe('event store', () => {
  it('replaces an utterance when the same utterance_id is re-emitted', () => {
    const state = applyEvents(createInitialState(), scriptEvents.slice(0, 2));
    expect(Object.keys(state.utterances).filter((id) => id === 'lu1')).toHaveLength(1);
    expect(state.utterances.lu1.text).toBe('Maya, is the Oakland place still September fifteenth?');
    expect(state.utterances.lu1.is_final).toBe(true);
  });

  it('supersedes the seeded fact rather than duplicating it', () => {
    const state = applyEvents(createInitialState(true), scriptEvents);
    expect(state.facts['f-maya-move-2'].superseded_by).toBe('f-maya-move-3');
    expect(state.facts['f-maya-move-3'].superseded_by).toBeUndefined();

    const currentMoveDates = Object.values(state.facts)
      .filter((fact) => fact.person_id === 'p-maya' && fact.attribute === 'move_date' && !fact.superseded_by);
    expect(currentMoveDates).toHaveLength(1);
    expect(currentMoveDates[0].claim).toBe('Moving to Oakland on September 20');
  });

  it('surfaces an unnamed speaker and keeps their turns attributed to them', () => {
    const state = applyEvents(createInitialState(), scriptEvents);
    const unknown = state.people[UNKNOWN_PERSON_ID];
    expect(isUnnamed(unknown)).toBe(true);
    expect(state.utterances.lu3.person_id).toBe(UNKNOWN_PERSON_ID);
    expect(state.utterances.lu5.person_id).toBe(UNKNOWN_PERSON_ID);
  });

  it('re-labels an already-rendered bubble to a different speaker', () => {
    const firstLu4Index = scriptEvents.findIndex(
      (event) => event.type === 'utterance' && event.utterance_id === 'lu4',
    );
    const beforeRelabel = applyEvents(createInitialState(), scriptEvents.slice(0, firstLu4Index + 1));
    expect(beforeRelabel.utterances.lu4.person_id).toBe('p-jules');

    const afterRelabel = applyEvents(createInitialState(), scriptEvents);
    expect(afterRelabel.utterances.lu4.person_id).toBe('p-priya');
  });

  it('never blanks a name the owner already gave', () => {
    const named = applyEvents(createInitialState(), scriptEvents);
    const relabelled = applyEvents(named, [
      { type: 'identity', conversation_id: LIVE_CONVERSATION_ID, person_id: 'p-priya', name: '', utterance_ids: ['lu4'] },
    ]);
    expect(relabelled.people['p-priya'].name).toBe('Priya');
  });

  it('collects one Amelia turn with steps then a spoken reply', () => {
    const state = applyEvents(createInitialState(), scriptEvents);
    expect(state.amelia?.request_id).toBe('req-live-1');
    expect(state.amelia?.steps.length).toBeGreaterThanOrEqual(6);
    expect(state.amelia?.done).toBe(true);
    expect(state.amelia?.reply).toContain('September 20');
  });

  it('marks an unsolicited contradiction response as a live context update', () => {
    const contextAudioIndex = scriptEvents.findIndex(
      (event) => event.type === 'amelia_audio' && event.request_id.startsWith('context-'),
    );
    const state = applyEvents(createInitialState(), scriptEvents.slice(0, contextAudioIndex + 1));

    expect(state.amelia?.kind).toBe('context_update');
    expect(state.amelia?.reply).toBe(
      'That changed: Maya is moving to Oakland on September 20. I found 1 related open loop worth reviewing.',
    );
    expect(state.amelia?.conversation_id).toBe(LIVE_CONVERSATION_ID);
  });

  it('records the live promise with a due date so it can be scheduled', () => {
    const state = applyEvents(createInitialState(), scriptEvents);
    const promise = state.promises['pr-live-boxes'];
    expect(promise.status).toBe('open');
    expect(new Date(promise.due_at!).getTime()).toBeGreaterThan(Date.now());
  });

  it('tracks conversation participants as speakers arrive', () => {
    const state = applyEvents(createInitialState(), scriptEvents);
    const conversation = state.conversations[LIVE_CONVERSATION_ID];
    expect(conversation.participant_ids).toContain('p-maya');
    expect(conversation.participant_ids).toContain(UNKNOWN_PERSON_ID);
    // Arriving utterances must NOT mark a conversation live: hydrating or polling an old
    // one would otherwise stamp it "Listening now". Only the recording session sets it.
    expect(state.liveConversationId).toBeNull();
  });
});
