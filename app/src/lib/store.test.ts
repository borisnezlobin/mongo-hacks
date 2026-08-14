import { describe, expect, it } from 'vitest';
import type { AmeliaEvent } from '../../../shared/contracts';
import { mockScript, LIVE_CONVERSATION_ID } from './mock-sse';
import { applyEvents, createInitialState, isUnnamed, reduce } from './store';
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

  describe('attribution pending state', () => {
    const utterance: AmeliaEvent = {
      type: 'utterance',
      utterance_id: 'u-pending',
      conversation_id: LIVE_CONVERSATION_ID,
      text: 'Yeah, exactly.',
      start_ms: 0,
      end_ms: 900,
      is_final: true,
    };
    const pending: AmeliaEvent = {
      type: 'speaker_pending',
      conversation_id: LIVE_CONVERSATION_ID,
      session_speaker: 'cluster-0',
      utterance_ids: ['u-pending'],
      speech_ms: 900,
      embed_min_ms: 3000,
    };

    it('marks a turn as being worked on rather than unknown', () => {
      const state = applyEvents(createInitialState(), [utterance, pending]);
      expect(state.attributing['u-pending']).toBe(true);
    });

    it('clears the pending mark once identity resolves', () => {
      const state = applyEvents(createInitialState(), [
        utterance,
        pending,
        {
          type: 'identity',
          conversation_id: LIVE_CONVERSATION_ID,
          person_id: 'p-maya',
          name: 'Maya',
          utterance_ids: ['u-pending'],
        },
      ]);
      expect(state.attributing['u-pending']).toBeUndefined();
      expect(state.utterances['u-pending'].person_id).toBe('p-maya');
    });

    /**
     * The transcript screen polls, so a settled turn is re-delivered constantly.
     * A late pending event must not drag a named row back to "Attributing…".
     */
    it('ignores a late pending event for an already-attributed turn', () => {
      const state = applyEvents(createInitialState(), [
        { ...utterance, person_id: 'p-maya' } as AmeliaEvent,
        pending,
      ]);
      expect(state.attributing['u-pending']).toBeUndefined();
    });

    it('clears the pending mark when a revision arrives carrying the person', () => {
      const state = applyEvents(createInitialState(), [
        utterance,
        pending,
        { ...utterance, person_id: 'p-maya' } as AmeliaEvent,
      ]);
      expect(state.attributing['u-pending']).toBeUndefined();
    });
  });

  describe('conversation titles', () => {
    const started = '2026-08-14T19:16:00.000Z';

    /**
     * The client synthesises "Conversation, 12:16 PM" from the first turn, so
     * preferring the local title unconditionally meant a generated one could
     * never land however good it was.
     */
    it('lets a server title replace the synthesised timestamp one', () => {
      let state = applyEvents(createInitialState(), [{
        type: 'utterance',
        utterance_id: 'u1',
        conversation_id: 'c-1',
        text: 'Hello there',
        start_ms: 0,
        end_ms: 900,
        is_final: true,
      }]);
      expect(state.conversations['c-1'].title).toMatch(/^Conversation,/);

      state = applyEvents(state, [{
        type: 'conversation',
        conversation_id: 'c-1',
        title: 'Oakland move and venue photos',
      }]);
      expect(state.conversations['c-1'].title).toBe('Oakland move and venue photos');
    });

    it('never overwrites a title the owner typed', () => {
      const store = createInitialState();
      let state = applyEvents(store, [{
        type: 'utterance',
        utterance_id: 'u1',
        conversation_id: 'c-1',
        text: 'Hello',
        start_ms: 0,
        end_ms: 900,
        is_final: true,
      }]);
      state = reduce(state, { kind: 'rename-conversation', conversationId: 'c-1', title: 'Dinner with Jerry' });

      state = applyEvents(state, [{
        type: 'conversation',
        conversation_id: 'c-1',
        title: 'Something the model made up',
      }]);
      expect(state.conversations['c-1'].title).toBe('Dinner with Jerry');

      state = reduce(state, {
        kind: 'upsert-conversations',
        conversations: [{
          _id: 'c-1',
          owner_id: 'owner',
          started_at: started,
          title: 'Something the model made up',
          participant_ids: [],
        }],
      });
      expect(state.conversations['c-1'].title).toBe('Dinner with Jerry');
    });
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
