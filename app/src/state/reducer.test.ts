import { describe, expect, it } from 'vitest';
import type { AmeliaEvent } from '../../../shared/contracts';
import { mockScript, LIVE_CONVERSATION_ID } from '../lib/mock-sse';
import { UNKNOWN_PERSON_ID } from '../lib/seed';
import {
  ATTRIBUTION_TIMEOUT_MS,
  applyEvents,
  createInitialState,
  isUnnamed,
  reduce,
  speakerLabel,
  type AmeliaState,
} from './reducer';
import {
  selectLatestAmeliaTurn,
  selectListedConversations,
  selectLiveConversationId,
  selectNameSuggestionFor,
  selectOwnerId,
  selectYouOwe,
} from './selectors';

const scriptEvents: AmeliaEvent[] = mockScript.map((item) => item.event);

const utteranceEvent = (overrides: Partial<Extract<AmeliaEvent, { type: 'utterance' }>> = {}): AmeliaEvent => ({
  type: 'utterance',
  utterance_id: 'u1',
  conversation_id: 'c-1',
  text: 'Hello there',
  start_ms: 0,
  end_ms: 900,
  is_final: true,
  ...overrides,
});

/** Puts the machine into a live session, the way the mic control does. */
function recording(state: AmeliaState, conversationId: string): AmeliaState {
  let next = reduce(state, { kind: 'recording', event: { type: 'start', conversationId } });
  next = reduce(next, { kind: 'recording', event: { type: 'permission-granted' } });
  return reduce(next, { kind: 'recording', event: { type: 'connected' } });
}

describe('event store', () => {
  it('replaces an utterance when the same utterance_id is re-emitted', () => {
    const state = applyEvents(createInitialState(false), scriptEvents.slice(0, 2));
    expect(Object.keys(state.utterances).filter((id) => id === 'lu1')).toHaveLength(1);
    expect(state.utterances.lu1.text).toBe('Maya, is the Oakland place still September fifteenth?');
    expect(state.utterances.lu1.is_final).toBe(true);
  });

  it('returns the identical state object when a poll re-delivers an unchanged turn', () => {
    const first = applyEvents(createInitialState(false), [utteranceEvent()]);
    const again = applyEvents(first, [utteranceEvent()]);
    // Referential equality is the whole re-render story: an unchanged poll must not
    // produce a new state, or every consumer wakes up twice a second.
    expect(again).toBe(first);
  });

  it('drops a line the final pass superseded rather than showing it empty', () => {
    // The final pass rebuilds the transcript from a whole-file transcription
    // and carries ids across by time overlap. A live fragment with no
    // counterpart has to leave, or it sits under the corrected transcript
    // holding text nobody said.
    const first = applyEvents(createInitialState(false), [utteranceEvent()]);
    expect(first.utterances.u1).toBeDefined();

    const after = applyEvents(first, [utteranceEvent({ text: '', superseded: true })]);
    expect(after.utterances.u1).toBeUndefined();
  });

  it('ignores a supersede for a line it never had', () => {
    const state = applyEvents(createInitialState(false), [utteranceEvent()]);
    expect(applyEvents(state, [utteranceEvent({ utterance_id: 'never-seen', superseded: true })])).toBe(state);
  });

  it('supersedes the seeded fact rather than duplicating it', () => {
    const state = applyEvents(createInitialState(true), scriptEvents);
    expect(state.facts['f-maya-move-2'].superseded_by).toBe('f-maya-move-3');
    expect(state.facts['f-maya-move-3'].superseded_by).toBeUndefined();

    const current = Object.values(state.facts)
      .filter((fact) => fact.person_id === 'p-maya' && fact.attribute === 'move_date' && !fact.superseded_by);
    expect(current).toHaveLength(1);
    expect(current[0].claim).toBe('Moving to Oakland on September 20');
  });

  it('surfaces an unnamed speaker and keeps their turns attributed to them', () => {
    const state = applyEvents(createInitialState(false), scriptEvents);
    expect(isUnnamed(state.people[UNKNOWN_PERSON_ID])).toBe(true);
    expect(state.utterances.lu3.person_id).toBe(UNKNOWN_PERSON_ID);
    expect(state.utterances.lu5.person_id).toBe(UNKNOWN_PERSON_ID);
  });

  it('re-labels an already-rendered bubble to a different speaker', () => {
    const firstLu4 = scriptEvents.findIndex((e) => e.type === 'utterance' && e.utterance_id === 'lu4');
    expect(applyEvents(createInitialState(false), scriptEvents.slice(0, firstLu4 + 1)).utterances.lu4.person_id)
      .toBe('p-jules');
    expect(applyEvents(createInitialState(false), scriptEvents).utterances.lu4.person_id).toBe('p-priya');
  });

  it('never blanks a name the owner already gave', () => {
    const named = applyEvents(createInitialState(false), scriptEvents);
    const relabelled = applyEvents(named, [{
      type: 'identity',
      conversation_id: LIVE_CONVERSATION_ID,
      person_id: 'p-priya',
      name: '',
      utterance_ids: ['lu4'],
      confidence: 'confirmed',
    }]);
    expect(relabelled.people['p-priya'].name).toBe('Priya');
  });

  it('records the live promise with a due date so it can be scheduled', () => {
    const state = applyEvents(createInitialState(false), scriptEvents);
    const promise = state.promises['pr-live-boxes'];
    expect(promise.status).toBe('open');
    expect(new Date(promise.due_at!).getTime()).toBeGreaterThan(Date.now());
  });

  it('tracks conversation participants as speakers arrive without marking anything live', () => {
    const state = applyEvents(createInitialState(false), scriptEvents);
    const conversation = state.conversations[LIVE_CONVERSATION_ID];
    expect(conversation.participant_ids).toContain('p-maya');
    expect(conversation.participant_ids).toContain(UNKNOWN_PERSON_ID);
    // Only the recording machine decides what is live.
    expect(selectLiveConversationId(state)).toBeNull();
  });
});

describe('Amelia turns', () => {
  it('collects one turn with steps then a spoken reply', () => {
    const state = applyEvents(createInitialState(false), scriptEvents);
    const turn = selectLatestAmeliaTurn(state)!;
    expect(turn.request_id).toBe('req-live-1');
    expect(turn.steps.length).toBeGreaterThanOrEqual(6);
    expect(turn.done).toBe(true);
    expect(turn.reply).toContain('September 20');
  });

  it('marks an unsolicited contradiction response as a live context update', () => {
    const index = scriptEvents.findIndex((e) => e.type === 'amelia_audio' && e.request_id.startsWith('context-'));
    const state = applyEvents(createInitialState(false), scriptEvents.slice(0, index + 1));
    const turn = selectLatestAmeliaTurn(state)!;
    expect(turn.kind).toBe('context_update');
    expect(turn.reply).toContain('September 20');
  });

  /** A single slot meant a second answer erased the first while it was being read. */
  it('keeps an earlier answer when a second request arrives', () => {
    let state = applyEvents(createInitialState(false), [
      { type: 'amelia_audio', request_id: 'req-a', text: 'The first answer' },
    ]);
    state = applyEvents(state, [
      { type: 'amelia_step', request_id: 'req-b', step: 'search', message: 'Looking' },
    ]);
    expect(state.ameliaTurns['req-a'].reply).toBe('The first answer');
    expect(selectLatestAmeliaTurn(state)?.request_id).toBe('req-b');
  });

  /**
   * Hydration used to stamp "most recent conversation", so a cold start put Amelia's
   * first answer on whichever old transcript happened to hydrate last.
   */
  it('attaches a turn to the live session, never to a hydrated one', () => {
    let state = createInitialState(false);
    state = reduce(state, {
      kind: 'hydrate-utterances',
      utterances: [{
        _id: 'old-1',
        owner_id: 'owner',
        conversation_id: 'c-ancient',
        text: 'From last week',
        start_ms: 0,
        end_ms: 900,
        is_final: true,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      }],
    });
    state = recording(state, 'c-now');
    state = applyEvents(state, [{ type: 'amelia_audio', request_id: 'req-1', text: 'Here you go' }]);
    expect(state.ameliaTurns['req-1'].conversation_id).toBe('c-now');
  });
});

describe('attribution', () => {
  const pending: AmeliaEvent = {
    type: 'speaker_pending',
    conversation_id: LIVE_CONVERSATION_ID,
    session_speaker: 'cluster-0',
    utterance_ids: ['u-pending'],
    speech_ms: 900,
    provisional_speech_ms: 3000,
    reason: 'gathering',
  };
  const turn = utteranceEvent({ utterance_id: 'u-pending', conversation_id: LIVE_CONVERSATION_ID, text: 'Yeah, exactly.' });

  it('marks a turn as being worked on rather than unknown', () => {
    const state = applyEvents(createInitialState(false), [turn, pending]);
    expect(state.attributing['u-pending']).toMatchObject({ reason: 'gathering' });
    expect(state.attributing['u-pending'].since).toBeTypeOf('number');
  });

  /** Which cluster spoke is what lets a suggestion for an unresolved voice find its rows. */
  it('remembers the cluster credited with the turn', () => {
    const state = applyEvents(createInitialState(false), [turn, pending]);
    expect(state.sessionSpeakerOf['u-pending']).toBe('cluster-0');
  });

  it('clears the pending mark once identity resolves', () => {
    const state = applyEvents(createInitialState(false), [turn, pending, {
      type: 'identity',
      conversation_id: LIVE_CONVERSATION_ID,
      person_id: 'p-maya',
      name: 'Maya',
      utterance_ids: ['u-pending'],
      confidence: 'confirmed',
    }]);
    expect(state.attributing['u-pending']).toBeUndefined();
    expect(state.utterances['u-pending'].person_id).toBe('p-maya');
  });

  it('ignores a late pending event for an already-attributed turn', () => {
    const state = applyEvents(createInitialState(false), [{ ...turn, person_id: 'p-maya' } as AmeliaEvent, pending]);
    expect(state.attributing['u-pending']).toBeUndefined();
  });

  /** Attribution can simply never arrive; a row that pulses forever reads as a hang. */
  it('gives up on an answer that never came', () => {
    const started = applyEvents(createInitialState(false), [turn, pending]);
    const { since } = started.attributing['u-pending'];

    const early = reduce(started, { kind: 'expire-attributions', now: since + ATTRIBUTION_TIMEOUT_MS - 1 });
    expect(early.attributing['u-pending']).toBeDefined();

    const late = reduce(started, { kind: 'expire-attributions', now: since + ATTRIBUTION_TIMEOUT_MS + 1 });
    expect(late.attributing['u-pending']).toBeUndefined();
  });
});

describe('naming', () => {
  /** The exact case the naming sheet exists for: a speaker with no record yet. */
  it('creates the person when naming a voice Amelia never resolved', () => {
    const state = reduce(createInitialState(false), {
      kind: 'name-person',
      personId: 'speaker-u9',
      name: 'Tarun',
      relationship: 'Sat opposite me',
      isOwner: false,
      voiceprintId: 'vp-9',
    });
    expect(state.people['speaker-u9']).toMatchObject({
      name: 'Tarun',
      relationship: 'Sat opposite me',
      voiceprint_id: 'vp-9',
    });
  });

  it('keeps relationship and the owner flag, which the old early return dropped', () => {
    const state = reduce(createInitialState(false), {
      kind: 'name-person',
      personId: 'speaker-u9',
      name: 'Me',
      relationship: 'Myself',
      isOwner: true,
    });
    expect(state.people['speaker-u9'].is_owner).toBe(true);
    expect(state.people['speaker-u9'].relationship).toBe('Myself');
    expect(selectOwnerId(state)).toBe('speaker-u9');
  });

  it('releases the previous owner when a different voice claims it', () => {
    let state = reduce(createInitialState(false), { kind: 'name-person', personId: 'p-a', name: 'A', isOwner: true });
    state = reduce(state, { kind: 'name-person', personId: 'p-b', name: 'B', isOwner: true });
    expect(state.people['p-a'].is_owner).toBe(false);
    expect(selectOwnerId(state)).toBe('p-b');
  });

  it('puts a person back exactly as they were when the server refuses', () => {
    let state = reduce(createInitialState(false), { kind: 'name-person', personId: 'p-a', name: 'Alex' });
    const before = state.people['p-a'];
    state = reduce(state, { kind: 'name-person', personId: 'p-a', name: 'Alexandra' });
    state = reduce(state, { kind: 'revert-person', personId: 'p-a', person: before });
    expect(state.people['p-a'].name).toBe('Alex');
  });

  it('removes a person entirely when the rejected change had created them', () => {
    let state = reduce(createInitialState(false), { kind: 'name-person', personId: 'p-new', name: 'Nope' });
    state = reduce(state, { kind: 'revert-person', personId: 'p-new', person: null });
    expect(state.people['p-new']).toBeUndefined();
  });
});

describe('merging duplicate voices', () => {
  it('re-points turns, facts, promises and participants at the surviving person', () => {
    let state = applyEvents(createInitialState(false), [
      utteranceEvent({ utterance_id: 'u1', person_id: 'p-old' }),
      utteranceEvent({ utterance_id: 'u2', person_id: 'p-dup' }),
      { type: 'promise', promise_id: 'pr-1', person_id: 'p-dup', text: 'Send the deck', status: 'open' },
    ]);
    state = reduce(state, { kind: 'name-person', personId: 'p-old', name: 'Sam' });
    state = reduce(state, { kind: 'name-person', personId: 'p-dup', name: 'Sam' });

    state = reduce(state, { kind: 'merge-people', keepId: 'p-old', mergedIds: ['p-dup'] });

    expect(state.people['p-dup']).toBeUndefined();
    expect(state.utterances['u2'].person_id).toBe('p-old');
    expect(state.promises['pr-1'].person_id).toBe('p-old');
    expect(state.conversations['c-1'].participant_ids).toEqual(['p-old']);
  });

  it('carries a picture across from the record being folded in', () => {
    let state = reduce(createInitialState(false), { kind: 'name-person', personId: 'p-old', name: 'Sam' });
    state = reduce(state, { kind: 'name-person', personId: 'p-dup', name: 'Sam' });
    state = reduce(state, { kind: 'set-avatar', personId: 'p-dup', uri: 'file:///sam.jpg' });
    state = reduce(state, { kind: 'merge-people', keepId: 'p-old', mergedIds: ['p-dup'] });
    expect(state.avatars['p-old']).toBe('file:///sam.jpg');
    expect(state.avatars['p-dup']).toBeUndefined();
  });
});

describe('avatars', () => {
  /** One home for pictures. A person named from scratch used to lose theirs. */
  it('survives being named after the picture was set', () => {
    let state = reduce(createInitialState(false), { kind: 'set-avatar', personId: 'speaker-1', uri: 'file:///a.jpg' });
    state = reduce(state, { kind: 'name-person', personId: 'speaker-1', name: 'Ada' });
    expect(state.avatars['speaker-1']).toBe('file:///a.jpg');
  });

  it('does not let a disk hydrate overwrite a picture chosen this session', () => {
    let state = reduce(createInitialState(false), { kind: 'set-avatar', personId: 'p-1', uri: 'file:///new.jpg' });
    state = reduce(state, { kind: 'hydrate-avatars', avatars: { 'p-1': 'file:///old.jpg', 'p-2': 'file:///two.jpg' } });
    expect(state.avatars['p-1']).toBe('file:///new.jpg');
    expect(state.avatars['p-2']).toBe('file:///two.jpg');
  });
});

describe('conversation titles', () => {
  it('lets a server title replace the synthesised timestamp one', () => {
    let state = applyEvents(createInitialState(false), [utteranceEvent()]);
    expect(state.conversations['c-1'].title).toMatch(/^Conversation,/);
    state = applyEvents(state, [{ type: 'conversation', conversation_id: 'c-1', title: 'Oakland move' }]);
    expect(state.conversations['c-1'].title).toBe('Oakland move');
  });

  it('never overwrites a title the owner typed', () => {
    let state = applyEvents(createInitialState(false), [utteranceEvent()]);
    state = reduce(state, { kind: 'rename-conversation', conversationId: 'c-1', title: 'Dinner with Jerry' });
    state = applyEvents(state, [{ type: 'conversation', conversation_id: 'c-1', title: 'Model guess' }]);
    expect(state.conversations['c-1'].title).toBe('Dinner with Jerry');

    state = reduce(state, {
      kind: 'upsert-conversations',
      conversations: [{
        _id: 'c-1',
        owner_id: 'owner',
        started_at: '2026-08-14T19:16:00.000Z',
        title: 'Model guess',
        participant_ids: [],
      }],
    });
    expect(state.conversations['c-1'].title).toBe('Dinner with Jerry');
  });
});

describe('deleting a conversation', () => {
  function seeded(): AmeliaState {
    let state = applyEvents(createInitialState(false), [
      utteranceEvent({ utterance_id: 'u1', conversation_id: 'c-1', person_id: 'p-a', text: 'One' }),
      utteranceEvent({ utterance_id: 'u2', conversation_id: 'c-2', person_id: 'p-a', text: 'Two' }),
      { type: 'fact', fact_id: 'f-1', person_id: 'p-a', attribute: 'work', claim: 'Teaches' },
      { type: 'promise', promise_id: 'pr-1', person_id: 'p-a', text: 'Send it', status: 'open' },
    ]);
    // Both derived records cite the turn in c-1.
    state = {
      ...state,
      facts: { ...state.facts, 'f-1': { ...state.facts['f-1'], primary_source_utterance_id: 'u1' } },
      promises: { ...state.promises, 'pr-1': { ...state.promises['pr-1'], source_utterance_id: 'u1' } },
    };
    return state;
  }

  /** The confirmation copy has always promised the facts go too. Now they do. */
  it('removes the transcript and everything that cited it', () => {
    const state = reduce(seeded(), { kind: 'delete-conversation', conversationId: 'c-1' });
    expect(state.conversations['c-1']).toBeUndefined();
    expect(state.utterances['u1']).toBeUndefined();
    expect(state.facts['f-1']).toBeUndefined();
    expect(state.promises['pr-1']).toBeUndefined();
    expect(state.utterances['u2']).toBeDefined();
  });

  it('stops the live session when the conversation being deleted is the one recording', () => {
    const state = reduce(recording(seeded(), 'c-1'), { kind: 'delete-conversation', conversationId: 'c-1' });
    expect(selectLiveConversationId(state)).toBe('c-1');
    expect(state.recording.status).toBe('stopping');
  });

  it('puts everything back when the server refuses the delete', () => {
    let state = reduce(seeded(), { kind: 'delete-conversation', conversationId: 'c-1' });
    state = reduce(state, { kind: 'undo-delete-conversation', conversationId: 'c-1' });
    expect(state.conversations['c-1']).toBeDefined();
    expect(state.utterances['u1']).toBeDefined();
    expect(state.facts['f-1']).toBeDefined();
    expect(state.promises['pr-1']).toBeDefined();
  });

  /** A successful delete must not be undone by the next poll re-listing it. */
  it('does not let a hydrate resurrect a deleted conversation', () => {
    const state = reduce(seeded(), { kind: 'delete-conversation', conversationId: 'c-1' });
    const after = reduce(state, {
      kind: 'upsert-conversations',
      conversations: [{ _id: 'c-1', owner_id: 'owner', started_at: '2026-08-14T00:00:00.000Z', participant_ids: [] }],
    });
    expect(after.conversations['c-1']).toBeUndefined();
  });
});

describe('who owes whom', () => {
  /** Compared against a seed constant before, so "You owe" was empty on a real server. */
  it('splits promises by the person actually marked as owner', () => {
    let state = applyEvents(createInitialState(false), [
      { type: 'promise', promise_id: 'pr-mine', person_id: 'p-me', text: 'Introduce them', status: 'open' },
      { type: 'promise', promise_id: 'pr-theirs', person_id: 'p-them', text: 'Send photos', status: 'open' },
    ]);
    expect(selectYouOwe(state)).toHaveLength(0);

    state = reduce(state, { kind: 'name-person', personId: 'p-me', name: 'Yan', isOwner: true });
    expect(selectYouOwe(state).map((promise) => promise._id)).toEqual(['pr-mine']);
  });
});

describe('promise status', () => {
  const opened = (): AmeliaState => applyEvents(createInitialState(false), [
    { type: 'promise', promise_id: 'pr-1', person_id: 'p-a', text: 'Send the deck', status: 'open' },
  ]);

  it('closes optimistically and registers the write as in flight', () => {
    const state = reduce(opened(), { kind: 'set-promise-status', promiseId: 'pr-1', status: 'done' });
    expect(state.promises['pr-1'].status).toBe('done');
    expect(state.promiseWrites['pr-1']).toBe('done');
  });

  /**
   * The whole point of the guard. Closing a loop is a deliberate act, and the server's
   * copy still says 'open' until the write lands — without this it un-closes itself
   * under the owner's finger on the very next bus event.
   */
  it('a bus event cannot un-close a promise while the write is in flight', () => {
    let state = reduce(opened(), { kind: 'set-promise-status', promiseId: 'pr-1', status: 'done' });
    state = applyEvents(state, [
      { type: 'promise', promise_id: 'pr-1', person_id: 'p-a', text: 'Send the deck', status: 'open' },
    ]);
    expect(state.promises['pr-1'].status).toBe('done');
  });

  it('a hydrate from GET /promises cannot un-close it either', () => {
    let state = reduce(opened(), { kind: 'set-promise-status', promiseId: 'pr-1', status: 'done' });
    state = reduce(state, {
      kind: 'hydrate-promises',
      promises: [{ ...state.promises['pr-1'], status: 'open' }],
    });
    expect(state.promises['pr-1'].status).toBe('done');
  });

  it('takes the server record once the write settles, and lifts the guard', () => {
    let state = reduce(opened(), { kind: 'set-promise-status', promiseId: 'pr-1', status: 'done' });
    state = reduce(state, {
      kind: 'settle-promise-status',
      promiseId: 'pr-1',
      promise: { ...state.promises['pr-1'], status: 'done' },
    });
    expect(state.promiseWrites['pr-1']).toBeUndefined();

    // With the guard off the server is authoritative again.
    state = applyEvents(state, [
      { type: 'promise', promise_id: 'pr-1', person_id: 'p-a', text: 'Send the deck', status: 'open' },
    ]);
    expect(state.promises['pr-1'].status).toBe('open');
  });

  it('puts the checkbox back when the server refuses', () => {
    let state = reduce(opened(), { kind: 'set-promise-status', promiseId: 'pr-1', status: 'done' });
    state = reduce(state, { kind: 'revert-promise-status', promiseId: 'pr-1', status: 'open' });
    expect(state.promises['pr-1'].status).toBe('open');
    expect(state.promiseWrites['pr-1']).toBeUndefined();
  });

  /** Loops was empty on a cold start: promises only ever arrived over the bus. */
  it('hydrates promises the phone has never seen', () => {
    const state = reduce(createInitialState(false), {
      kind: 'hydrate-promises',
      promises: [{
        _id: 'pr-9',
        owner_id: 'owner',
        person_id: 'p-a',
        source_utterance_id: 'u1',
        text: 'Bring the boxes',
        text_normalized: 'bring the boxes',
        status: 'open',
        created_at: '2026-08-14T00:00:00.000Z',
      }],
    });
    expect(state.promises['pr-9'].text).toBe('Bring the boxes');
  });

  it('returns the identical state when a hydrate re-delivers unchanged promises', () => {
    const first = reduce(opened(), { kind: 'hydrate-promises', promises: [opened().promises['pr-1']] });
    const again = reduce(first, { kind: 'hydrate-promises', promises: [first.promises['pr-1']] });
    expect(again).toBe(first);
  });
});

describe('overheard name suggestions', () => {
  const suggestion = (overrides: Partial<Extract<AmeliaEvent, { type: 'name_suggestion' }>> = {}): AmeliaEvent => ({
    type: 'name_suggestion',
    conversation_id: 'c-1',
    session_speaker: 'cluster-0',
    name: 'Josh',
    confidence: 0.55,
    evidence: 'Also Josh, tomorrow do you want to go to the game night?',
    evidence_utterance_id: 'u1',
    kind: 'vocative',
    ...overrides,
  });

  it('parks a suggestion against the voice it is for', () => {
    const state = applyEvents(createInitialState(false), [suggestion()]);
    expect(selectNameSuggestionFor(state, 'cluster-0')).toMatchObject({
      name: 'Josh',
      confidence: 0.55,
      evidence: 'Also Josh, tomorrow do you want to go to the game night?',
    });
  });

  /** It proposes; it never renames anybody on its own. */
  it('does not name anyone by itself', () => {
    const state = applyEvents(createInitialState(false), [suggestion()]);
    expect(state.people['cluster-0']).toBeUndefined();
  });

  it('is never offered for a voice that already has a real name', () => {
    let state = reduce(createInitialState(false), { kind: 'name-person', personId: 'p-1', name: 'Maya' });
    state = applyEvents(state, [suggestion({ session_speaker: 'p-1', person_id: 'p-1' })]);
    expect(state.nameSuggestions['p-1']).toBeUndefined();
    expect(selectNameSuggestionFor(state, 'p-1')).toBeUndefined();
  });

  /** A guessed name is not a name. The room saying "Josh" is still worth asking about. */
  it('is still offered for a voice attribution is only guessing at', () => {
    let state = applyEvents(createInitialState(false), [{
      type: 'identity',
      conversation_id: 'c-1',
      person_id: 'p-1',
      name: 'Tarun',
      utterance_ids: [],
      confidence: 'provisional',
    }]);
    state = applyEvents(state, [suggestion({ session_speaker: 'p-1', person_id: 'p-1' })]);
    expect(selectNameSuggestionFor(state, 'p-1')?.name).toBe('Josh');
  });

  /** Confidence climbs as evidence accumulates; the voice keeps one slot, not a pile. */
  it('replaces rather than duplicates when the same name is restated', () => {
    const state = applyEvents(createInitialState(false), [
      suggestion({ confidence: 0.55 }),
      suggestion({ confidence: 0.82, evidence: 'Josh, are you coming?' }),
    ]);
    expect(Object.keys(state.nameSuggestions)).toEqual(['cluster-0']);
    expect(state.nameSuggestions['cluster-0']).toMatchObject({
      confidence: 0.82,
      evidence: 'Josh, are you coming?',
    });
  });

  it('a rival name has to beat the one already offered', () => {
    const state = applyEvents(createInitialState(false), [
      suggestion({ name: 'Josh', confidence: 0.8 }),
      suggestion({ name: 'Jess', confidence: 0.6 }),
    ]);
    expect(state.nameSuggestions['cluster-0'].name).toBe('Josh');

    const better = applyEvents(state, [suggestion({ name: 'Jess', confidence: 0.9 })]);
    expect(better.nameSuggestions['cluster-0'].name).toBe('Jess');
  });

  it('ignores a suggestion with no voice to attach it to', () => {
    const state = applyEvents(createInitialState(false), [
      suggestion({ session_speaker: undefined, person_id: undefined }),
    ]);
    expect(Object.keys(state.nameSuggestions)).toHaveLength(0);
  });

  describe('dismissing', () => {
    it('sticks for that voice and that name', () => {
      let state = applyEvents(createInitialState(false), [suggestion()]);
      state = reduce(state, { kind: 'dismiss-name-suggestion', voiceId: 'cluster-0', name: 'Josh' });
      expect(selectNameSuggestionFor(state, 'cluster-0')).toBeUndefined();

      // Even said again, and more confidently.
      state = applyEvents(state, [suggestion({ confidence: 0.95 })]);
      expect(selectNameSuggestionFor(state, 'cluster-0')).toBeUndefined();
    });

    it('does not suppress a different name for the same voice', () => {
      let state = applyEvents(createInitialState(false), [suggestion()]);
      state = reduce(state, { kind: 'dismiss-name-suggestion', voiceId: 'cluster-0', name: 'Josh' });
      state = applyEvents(state, [suggestion({ name: 'Jess', evidence: 'Thanks Jess.' })]);
      expect(selectNameSuggestionFor(state, 'cluster-0')?.name).toBe('Jess');
    });

    it('does not suppress the same name for a different voice', () => {
      let state = applyEvents(createInitialState(false), [suggestion()]);
      state = reduce(state, { kind: 'dismiss-name-suggestion', voiceId: 'cluster-0', name: 'Josh' });
      state = applyEvents(state, [suggestion({ session_speaker: 'cluster-1' })]);
      expect(selectNameSuggestionFor(state, 'cluster-1')?.name).toBe('Josh');
    });
  });

  /**
   * Confirming has to go through the ordinary naming path, because that is what
   * persists the person and enrolls the voiceprint. If it did not, the voice would not
   * be recognised in the next conversation and the feature would not exist.
   */
  it('confirming through namePerson names the voice and clears the question', () => {
    let state = applyEvents(createInitialState(false), [
      utteranceEvent({ utterance_id: 'u1', conversation_id: 'c-1', text: 'Yeah I am around' }),
      suggestion(),
    ]);
    state = reduce(state, {
      kind: 'name-person',
      personId: 'cluster-0',
      name: state.nameSuggestions['cluster-0'].name,
    });
    state = reduce(state, { kind: 'attribute-utterances', utteranceIds: ['u1'], personId: 'cluster-0' });

    expect(state.people['cluster-0'].name).toBe('Josh');
    expect(state.people['cluster-0'].provisional).toBe(false);
    expect(state.utterances['u1'].person_id).toBe('cluster-0');
    expect(selectNameSuggestionFor(state, 'cluster-0')).toBeUndefined();
  });
});

describe('attribution confidence', () => {
  const identity = (confidence: 'pending' | 'provisional' | 'confirmed', name: string): AmeliaEvent => ({
    type: 'identity',
    conversation_id: 'c-1',
    person_id: 'p-1',
    name,
    utterance_ids: ['u1'],
    confidence,
  });

  /** Live attribution is wrong about 30% of the time; a confident wrong name is worse. */
  it('renders a provisional identity as a guess, never as a plain name', () => {
    const state = applyEvents(createInitialState(false), [identity('provisional', 'Josh')]);
    expect(state.people['p-1'].provisional).toBe(true);
    expect(speakerLabel(state.people['p-1'])).toBe('Probably Josh');
  });

  it('renders a confirmed identity plainly', () => {
    const state = applyEvents(createInitialState(false), [identity('confirmed', 'Josh')]);
    expect(state.people['p-1'].provisional).toBe(false);
    expect(speakerLabel(state.people['p-1'])).toBe('Josh');
  });

  it('lets a confirmation settle a name that was only a guess', () => {
    let state = applyEvents(createInitialState(false), [identity('provisional', 'Josh')]);
    state = applyEvents(state, [identity('confirmed', 'Josh')]);
    expect(speakerLabel(state.people['p-1'])).toBe('Josh');
  });

  it('never downgrades a name the owner set to a guess', () => {
    let state = reduce(createInitialState(false), { kind: 'name-person', personId: 'p-1', name: 'Maya' });
    state = applyEvents(state, [identity('provisional', 'Josh')]);
    expect(state.people['p-1'].name).toBe('Maya');
    expect(state.people['p-1'].provisional).toBe(false);
  });

  it('still attributes the turns, because it is the name that is uncertain', () => {
    const state = applyEvents(createInitialState(false), [
      utteranceEvent({ utterance_id: 'u1', conversation_id: 'c-1' }),
      identity('provisional', 'Josh'),
    ]);
    expect(state.utterances['u1'].person_id).toBe('p-1');
  });
});

describe('listing conversations at scale', () => {
  const serverRecord = (id: string) => ({
    _id: id,
    owner_id: 'owner',
    started_at: '2026-08-18T10:00:00.000Z',
    title: 'Dorm, Sunday night',
    participant_ids: [],
  });

  /**
   * The old test for "is this a shell" was "do we have its turns", which forced the app
   * to download every transcript on launch just to render a list of titles.
   */
  it('lists a conversation the server knows about without loading its turns', () => {
    const state = reduce(createInitialState(false), {
      kind: 'upsert-conversations',
      conversations: [serverRecord('c-dorm')],
    });
    expect(Object.keys(state.utterances)).toHaveLength(0);
    expect(selectListedConversations(state).map((c) => c._id)).toEqual(['c-dorm']);
  });

  /** A local session that captured nothing still opens onto an empty screen. */
  it('hides a locally minted conversation that captured nothing', () => {
    let state = applyEvents(createInitialState(false), [utteranceEvent({ conversation_id: 'c-real' })]);
    state = reduce(state, { kind: 'recording', event: { type: 'start', conversationId: 'c-empty' } });
    state = {
      ...state,
      conversations: {
        ...state.conversations,
        'c-empty': {
          _id: 'c-empty',
          owner_id: 'owner',
          started_at: '2026-08-18T10:00:00.000Z',
          participant_ids: [],
        },
      },
    };
    expect(selectListedConversations(state).map((c) => c._id)).toEqual(['c-real']);
  });
});

describe('folding a long transcript in', () => {
  /**
   * This was quadratic: every turn spread the whole utterance map to make the next one.
   * At 2,772 turns that measured 870 ms of blocked main thread per hydrate. The
   * assertion here is on the shape that caused it — one pass, containers cloned once.
   */
  it('hydrates thousands of turns without rebuilding the map per turn', () => {
    const utterances = Array.from({ length: 3_000 }, (_, index) => ({
      _id: `u${index}`,
      owner_id: 'owner',
      conversation_id: 'c-dorm',
      person_id: `p-${index % 7}`,
      text: `Turn number ${index}`,
      start_ms: index * 1_000,
      end_ms: index * 1_000 + 900,
      is_final: true,
      created_at: '2026-08-18T00:00:00.000Z',
      updated_at: '2026-08-18T00:00:00.000Z',
    }));

    const started = Date.now();
    const state = reduce(createInitialState(false), { kind: 'hydrate-utterances', utterances });
    expect(Object.keys(state.utterances)).toHaveLength(3_000);
    expect(state.conversations['c-dorm'].participant_ids).toHaveLength(7);
    // Generous enough not to be flaky on a loaded machine, tight enough that the
    // quadratic version (~1s) could never pass it.
    expect(Date.now() - started).toBeLessThan(250);
  });

  it('still returns the identical state when the whole transcript is re-delivered', () => {
    const utterances = Array.from({ length: 500 }, (_, index) => ({
      _id: `u${index}`,
      owner_id: 'owner',
      conversation_id: 'c-dorm',
      person_id: 'p-1',
      text: `Turn ${index}`,
      start_ms: index * 1_000,
      end_ms: index * 1_000 + 900,
      is_final: true,
      created_at: '2026-08-18T00:00:00.000Z',
      updated_at: '2026-08-18T00:00:00.000Z',
    }));
    const loaded = reduce(createInitialState(false), { kind: 'hydrate-utterances', utterances });
    expect(reduce(loaded, { kind: 'hydrate-utterances', utterances })).toBe(loaded);
  });

  /** A burst of turns in one debounced batch must cost one pass, not one clone each. */
  it('folds a batch of arriving turns in a single pass', () => {
    const events: AmeliaEvent[] = Array.from({ length: 40 }, (_, index) => utteranceEvent({
      utterance_id: `b${index}`,
      conversation_id: 'c-dorm',
      person_id: 'p-1',
      text: `Burst ${index}`,
      start_ms: index * 500,
    }));
    const state = reduce(createInitialState(false), { kind: 'events', events });
    expect(Object.keys(state.utterances)).toHaveLength(40);
  });

  /** Order still has to hold: an identity in the batch sees the turns before it. */
  it('keeps identity events in order with the turns around them', () => {
    const state = reduce(createInitialState(false), {
      kind: 'events',
      events: [
        utteranceEvent({ utterance_id: 'u1', conversation_id: 'c-1', text: 'Before' }),
        {
          type: 'identity',
          conversation_id: 'c-1',
          person_id: 'p-1',
          name: 'Maya',
          utterance_ids: ['u1', 'u2'],
          confidence: 'confirmed',
        },
        utteranceEvent({ utterance_id: 'u2', conversation_id: 'c-1', text: 'After', start_ms: 2_000 }),
      ],
    });
    expect(state.utterances['u1'].person_id).toBe('p-1');
    // u2 arrived after the identity that mentioned it, so it is still unattributed —
    // exactly as it would be if the events had been applied one at a time.
    expect(state.utterances['u2'].person_id).toBeUndefined();
  });
});

describe('notices', () => {
  it('does not stack the same message twice', () => {
    let state = reduce(createInitialState(false), { kind: 'notice', notice: { id: 'a', message: 'Offline', tone: 'error' } });
    state = reduce(state, { kind: 'notice', notice: { id: 'b', message: 'Offline', tone: 'error' } });
    expect(state.notices).toHaveLength(1);
  });

  it('drops one when it is dismissed', () => {
    let state = reduce(createInitialState(false), { kind: 'notice', notice: { id: 'a', message: 'Offline', tone: 'error' } });
    state = reduce(state, { kind: 'dismiss-notice', id: 'a' });
    expect(state.notices).toHaveLength(0);
  });
});
