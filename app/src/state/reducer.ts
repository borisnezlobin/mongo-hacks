import type {
  AmeliaEvent,
  Conversation,
  Fact,
  Id,
  IdentityConflictEvent,
  NameSuggestionEvent,
  Person,
  PromiseMemory,
  SpeakerPendingEvent,
  Utterance,
} from '../../../shared/contracts';
import { OWNER_ID } from '../../../shared/contracts';
import {
  initialRecordingState,
  liveConversationId,
  recordingReducer,
  type RecordingEvent,
  type RecordingState,
} from './recording';
import {
  DEMO_CONVERSATION_ID,
  seedConversations,
  seedFacts,
  seedPeople,
  seedPromises,
  seedUtterances,
} from '../lib/seed';
import { MOCK_ENABLED } from '../lib/config';
import {
  glassesReducer,
  initialGlassesState,
  type GlassesState,
  type GlassesUiEvent,
} from './glasses';
import {
  applyPresenceEvent,
  initialPresenceState,
  sweepPresence,
  type PresenceState,
} from './presence';

export interface PersonRecord extends Person {
  voiceprint_id?: Id;
  /**
   * The name came from live speaker attribution that is not sure yet, so it is a guess
   * and must never be rendered as an established name. Live attribution runs around a
   * 30% error rate on real audio, and a wrong name shown confidently is worse than no
   * name at all. Cleared the moment the owner confirms it or the server says confirmed.
   */
  provisional?: boolean;
}

/**
 * A name overheard in the conversation, proposed for a voice nobody has named.
 *
 * People say each other's names constantly, which is the cheapest enrollment signal
 * there is. This only ever proposes: the evidence is carried with it so the owner can
 * judge the guess in a second, and one tap goes through the ordinary naming path.
 */
export interface NameSuggestion {
  /** The voice this is for: a person id once attribution resolved, else the cluster. */
  voice_id: Id;
  conversation_id: Id;
  name: string;
  confidence: number;
  evidence: string;
  evidence_utterance_id?: Id;
  kind: NameSuggestionEvent['kind'];
}

/** Why a turn has no speaker yet — "still listening" is not the same as "unsure". */
export interface AttributionWait {
  since: number;
  reason: SpeakerPendingEvent['reason'];
}

/** One voice, one key, whichever route named it. */
export function suggestionKey(voiceId: Id, name: string): string {
  return `${voiceId}:${name.trim().toLowerCase()}`;
}

export interface AmeliaTurn {
  request_id: Id;
  kind: 'request' | 'context_update';
  steps: { step: string; message: string }[];
  reply?: string;
  audio_url?: string;
  conversation_id?: Id;
  done: boolean;
  started_at: number;
}

/** Where the app's data is coming from right now. The user is never left guessing. */
export type ConnectionSource = 'connecting' | 'live' | 'mock' | 'offline';

export interface Notice {
  id: string;
  message: string;
  tone: 'error' | 'info';
}

/** Everything a delete removed, kept only long enough to put it back if the server says no. */
export interface DeletedConversation {
  conversation?: Conversation;
  utterances: Utterance[];
  facts: Fact[];
  promises: PromiseMemory[];
}

export interface AmeliaState {
  people: Record<Id, PersonRecord>;
  facts: Record<Id, Fact>;
  promises: Record<Id, PromiseMemory>;
  utterances: Record<Id, Utterance>;
  conversations: Record<Id, Conversation>;
  /**
   * Amelia's turns, keyed by request. A single slot meant a second answer erased the
   * first while it was still being read out.
   */
  ameliaTurns: Record<Id, AmeliaTurn>;
  /** Request ids, oldest first, capped. Ordering a record's keys is not guaranteed. */
  ameliaOrder: Id[];
  recording: RecordingState;
  /**
   * Utterances the server is still attributing, with the epoch ms the wait started.
   * A timestamp rather than a flag so "Attributing…" can give up instead of pulsing
   * forever when the answer never arrives.
   */
  attributing: Record<Id, AttributionWait>;
  /**
   * utterance_id -> the diarization cluster credited with it, kept so a suggestion
   * addressed to a cluster can be matched to the rows that cluster spoke. Without it a
   * suggestion for a voice attribution has not resolved yet has nowhere to appear.
   */
  sessionSpeakerOf: Record<Id, Id>;
  /** Proposed names, one per voice. A better-evidenced restatement replaces its slot. */
  nameSuggestions: Record<Id, NameSuggestion>;
  /** Turned-down suggestions, keyed by voice AND name, so a different name still asks. */
  dismissedSuggestions: Record<string, true>;
  renamedConversations: Record<Id, true>;
  /**
   * Conversations the server has listed. A record that came from the server is real
   * even before its transcript is loaded, which is what lets Home list conversations
   * without downloading every one of them to find out whether it has any turns.
   */
  serverConversations: Record<Id, true>;
  /**
   * Status changes the owner has made that the server has not confirmed yet, by promise
   * id. Closing a loop is a deliberate act, so while the write is in flight every
   * inbound copy of that promise is ignored — otherwise the next poll or bus event,
   * which still says 'open', quietly un-closes it under the owner's finger.
   */
  promiseWrites: Record<Id, PromiseMemory['status']>;
  /**
   * Profile pictures by person id — the single home for them. They used to also live
   * on the person record, and a person created by the naming sheet was built without
   * that field, so naming a face dropped its picture.
   */
  avatars: Record<Id, string>;
  /** Who is in the room, by face or by voice. Expires on its own; see presence.ts. */
  presence: PresenceState;
  /**
   * A face and a voice naming different people in the same breath, keyed by the
   * pair. Never resolved here: it is a question for the owner, and the only
   * thing the app does with it is ask.
   */
  identityConflicts: Record<string, IdentityConflictEvent>;
  glasses: GlassesState;
  connection: ConnectionSource;
  notices: Notice[];
  deleted: Record<Id, DeletedConversation>;
  unknownCardDismissed: boolean;
}

export type Action =
  | { kind: 'events'; events: AmeliaEvent[] }
  /** Bulk records pulled from REST. Never treated as "something just happened". */
  | { kind: 'hydrate-utterances'; utterances: Utterance[] }
  | { kind: 'name-person'; personId: Id; name: string; relationship?: string; isOwner?: boolean; voiceprintId?: Id }
  | { kind: 'revert-person'; person: PersonRecord | null; personId: Id }
  | { kind: 'merge-people'; keepId: Id; mergedIds: Id[] }
  | { kind: 'set-avatar'; personId: Id; uri: string }
  | { kind: 'set-promise-status'; promiseId: Id; status: PromiseMemory['status'] }
  | { kind: 'settle-promise-status'; promiseId: Id; promise?: PromiseMemory }
  | { kind: 'revert-promise-status'; promiseId: Id; status: PromiseMemory['status'] }
  | { kind: 'hydrate-promises'; promises: PromiseMemory[] }
  | { kind: 'rename-conversation'; conversationId: Id; title: string }
  | { kind: 'delete-conversation'; conversationId: Id }
  | { kind: 'undo-delete-conversation'; conversationId: Id }
  | { kind: 'forget-deleted'; conversationId: Id }
  | { kind: 'dismiss-name-suggestion'; voiceId: Id; name: string }
  | { kind: 'dismiss-unknown-card' }
  | { kind: 'recording'; event: RecordingEvent }
  | { kind: 'expire-attributions'; now: number }
  | { kind: 'attribute-utterances'; utteranceIds: Id[]; personId: Id }
  | { kind: 'upsert-conversations'; conversations: Conversation[] }
  | { kind: 'upsert-people'; people: Person[] }
  | { kind: 'hydrate-avatars'; avatars: Record<Id, string> }
  | { kind: 'set-connection'; source: ConnectionSource }
  | { kind: 'sweep-presence'; now: number }
  | { kind: 'glasses'; event: GlassesUiEvent }
  | { kind: 'notice'; notice: Notice }
  | { kind: 'dismiss-notice'; id: string };

/** After this long with no answer, "Attributing…" is a lie; the row says unknown instead. */
export const ATTRIBUTION_TIMEOUT_MS = 20_000;
/** Amelia turns worth keeping around. Old traces are history, not state. */
const MAX_AMELIA_TURNS = 8;

const UNNAMED_PATTERN = /^(unknown|unnamed|speaker\b)/i;

export function isUnnamed(person: Pick<PersonRecord, 'name'> | undefined): boolean {
  if (!person) return true;
  return person.name.trim().length === 0 || UNNAMED_PATTERN.test(person.name.trim());
}

/** A stable, human-readable stand-in until the owner names the voice. */
export function displayName(person: PersonRecord | undefined, fallbackIndex = 0): string {
  if (!person) return 'Unknown speaker';
  if (!isUnnamed(person)) return person.name;
  return fallbackIndex > 0 ? `Unknown speaker ${fallbackIndex}` : 'Unknown speaker';
}

/**
 * What to put on a transcript row or a people row.
 *
 * A name live attribution is not sure about is hedged out loud. Attribution runs around
 * a 30% error rate on real audio, so rendering a guess as a plain name tells the owner
 * something we do not know — and a confidently wrong name is worse than no name.
 */
export function speakerLabel(person: PersonRecord | undefined): string {
  if (person?.provisional && !isUnnamed(person)) return `Probably ${person.name}`;
  return displayName(person);
}

function omit<T>(record: Record<Id, T>, key: Id): Record<Id, T> {
  if (!(key in record)) return record;
  const { [key]: _removed, ...rest } = record;
  return rest;
}

function byId<T extends { _id: Id }>(items: T[]): Record<Id, T> {
  return Object.fromEntries(items.map((item) => [item._id, item]));
}

function startAmeliaTurn(requestId: Id, conversationId: Id | null): AmeliaTurn {
  return {
    request_id: requestId,
    kind: requestId.startsWith('context-') ? 'context_update' : 'request',
    steps: [],
    done: false,
    conversation_id: conversationId ?? undefined,
    started_at: Date.now(),
  };
}

function withAmeliaTurn(state: AmeliaState, requestId: Id, update: (turn: AmeliaTurn) => AmeliaTurn): AmeliaState {
  const existing = state.ameliaTurns[requestId];
  const turn = existing ?? startAmeliaTurn(requestId, liveConversationId(state.recording));
  const ameliaTurns = { ...state.ameliaTurns, [requestId]: update(turn) };
  const ameliaOrder = existing ? state.ameliaOrder : [...state.ameliaOrder, requestId];
  if (ameliaOrder.length <= MAX_AMELIA_TURNS) return { ...state, ameliaTurns, ameliaOrder };
  const dropped = ameliaOrder.slice(0, ameliaOrder.length - MAX_AMELIA_TURNS);
  for (const id of dropped) delete ameliaTurns[id];
  return { ...state, ameliaTurns, ameliaOrder: ameliaOrder.slice(dropped.length) };
}

/**
 * Real data only. The seeded people and conversations existed to build the UI before the
 * server did; shipping them means invented people sit alongside actual speakers. They are
 * opt-in via EXPO_PUBLIC_FORCE_MOCK.
 */
export function createInitialState(withSeed: boolean = MOCK_ENABLED): AmeliaState {
  const empty: AmeliaState = {
    people: {},
    facts: {},
    promises: {},
    utterances: {},
    conversations: {},
    ameliaTurns: {},
    ameliaOrder: [],
    recording: initialRecordingState,
    attributing: {},
    sessionSpeakerOf: {},
    nameSuggestions: {},
    dismissedSuggestions: {},
    renamedConversations: {},
    serverConversations: {},
    promiseWrites: {},
    avatars: {},
    presence: initialPresenceState,
    identityConflicts: {},
    glasses: initialGlassesState,
    connection: 'connecting',
    notices: [],
    deleted: {},
    unknownCardDismissed: false,
  };
  if (!withSeed) return empty;
  return {
    ...empty,
    people: byId(seedPeople as PersonRecord[]),
    facts: byId(seedFacts),
    promises: byId(seedPromises),
    utterances: byId(seedUtterances),
    conversations: byId(seedConversations),
  };
}

function titleFor(startedAt: string): string {
  return `Conversation, ${new Date(startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

function ensureConversation(state: AmeliaState, conversationId: Id, timestamp: string): Conversation {
  return (
    state.conversations[conversationId] ?? {
      _id: conversationId,
      owner_id: OWNER_ID,
      started_at: timestamp,
      title: titleFor(timestamp),
      participant_ids: [],
    }
  );
}

interface IncomingUtterance {
  utterance_id: Id;
  conversation_id: Id;
  person_id?: Id;
  voiceprint_id?: Id;
  text: string;
  start_ms: number;
  end_ms: number;
  is_final: boolean;
}

/**
 * Folds a batch of turns into state in one pass.
 *
 * This used to be one-turn-at-a-time, and each turn spread the whole utterance map to
 * make the next one — quadratic in the size of the transcript. On a 48-minute recording
 * of 2,772 turns that is roughly 7.7 million property copies, measured at 870 ms of
 * blocked main thread every time the screen hydrated. Cloning the containers once and
 * filling them locally makes it linear: the same load measures ~9 ms.
 *
 * The containers are only cloned if something actually changed, so a poll that
 * re-delivers an unchanged transcript still returns the identical state object and wakes
 * nobody up.
 */
function mergeUtterances(state: AmeliaState, incoming: IncomingUtterance[], nowIso: string): AmeliaState {
  let utterances = state.utterances;
  let conversations = state.conversations;
  let attributing = state.attributing;
  let changed = false;

  for (const item of incoming) {
    const previous = utterances[item.utterance_id];
    const utterance: Utterance = {
      _id: item.utterance_id,
      owner_id: OWNER_ID,
      conversation_id: item.conversation_id,
      // Never downgrade a known speaker to unknown: polling re-delivers the server's copy,
      // which has no person_id for anything the voiceprint pass could not resolve.
      person_id: item.person_id ?? previous?.person_id,
      voiceprint_id: item.voiceprint_id ?? previous?.voiceprint_id,
      text: item.text,
      start_ms: item.start_ms,
      end_ms: item.end_ms,
      is_final: item.is_final,
      created_at: previous?.created_at ?? nowIso,
      updated_at: nowIso,
    };
    // An identical re-delivery must not produce a new object, or every poll re-renders
    // every row it touched.
    if (previous
      && previous.text === utterance.text
      && previous.person_id === utterance.person_id
      && previous.voiceprint_id === utterance.voiceprint_id
      && previous.is_final === utterance.is_final
      && previous.start_ms === utterance.start_ms
      && previous.end_ms === utterance.end_ms) {
      continue;
    }

    if (!changed) {
      utterances = { ...utterances };
      conversations = { ...conversations };
      attributing = { ...attributing };
      changed = true;
    }

    utterances[utterance._id] = utterance;
    if (utterance.person_id) delete attributing[utterance._id];

    const conversation = conversations[item.conversation_id]
      ?? {
        _id: item.conversation_id,
        owner_id: OWNER_ID,
        started_at: nowIso,
        title: titleFor(nowIso),
        participant_ids: [],
      };
    const participants = item.person_id && !conversation.participant_ids.includes(item.person_id)
      ? [...conversation.participant_ids, item.person_id]
      : conversation.participant_ids;
    if (participants !== conversation.participant_ids || !state.conversations[item.conversation_id]) {
      conversations[conversation._id] = { ...conversation, participant_ids: participants };
    }
  }

  return changed ? { ...state, utterances, conversations, attributing } : state;
}

function applyEvent(state: AmeliaState, event: AmeliaEvent): AmeliaState {
  const nowIso = new Date().toISOString();

  switch (event.type) {
    case 'utterance': {
      // A superseded line is gone, not empty. The final pass rebuilds the
      // transcript from a whole-file transcription and carries ids across by
      // time overlap; the handful with no counterpart have to leave, or they
      // sit under the corrected transcript holding text nobody said.
      if (!event.superseded) return mergeUtterances(state, [event], nowIso);
      if (!state.utterances[event.utterance_id]) return state;
      const utterances = { ...state.utterances };
      const attributing = { ...state.attributing };
      delete utterances[event.utterance_id];
      delete attributing[event.utterance_id];
      return { ...state, utterances, attributing };
    }

    case 'conversation': {
      const conversation = ensureConversation(state, event.conversation_id, nowIso);
      return {
        ...state,
        conversations: {
          ...state.conversations,
          [conversation._id]: {
            ...conversation,
            // A title the owner typed outranks one the model generated.
            title: state.renamedConversations[conversation._id] ? conversation.title : event.title ?? conversation.title,
            ended_at: event.ended_at ?? conversation.ended_at,
          },
        },
      };
    }

    case 'speaker_pending': {
      const attributing = { ...state.attributing };
      const sessionSpeakerOf = { ...state.sessionSpeakerOf };
      let changed = false;
      for (const utteranceId of event.utterance_ids) {
        if (sessionSpeakerOf[utteranceId] !== event.session_speaker) {
          sessionSpeakerOf[utteranceId] = event.session_speaker;
          changed = true;
        }
        // An utterance that already has a person is settled; a late pending event for
        // it must not drag it back into limbo.
        if (state.utterances[utteranceId]?.person_id) continue;
        const waiting = attributing[utteranceId];
        if (waiting && waiting.reason === event.reason) continue;
        // A reason that changed from 'gathering' to 'no_match' is news, not a repeat:
        // one means keep waiting, the other means we listened and could not tell.
        attributing[utteranceId] = { since: waiting?.since ?? Date.now(), reason: event.reason };
        changed = true;
      }
      return changed ? { ...state, attributing, sessionSpeakerOf } : state;
    }

    /**
     * A name overheard in the room. It is never applied — it is parked against the
     * voice until the owner taps it, and a voice that already has a real name or a
     * suggestion the owner turned down is left alone.
     */
    case 'name_suggestion': {
      const voiceId = event.person_id ?? event.session_speaker;
      if (!voiceId || !event.name.trim()) return state;
      const person = state.people[voiceId];
      if (person && !isUnnamed(person) && !person.provisional) return state;
      if (state.dismissedSuggestions[suggestionKey(voiceId, event.name)]) return state;

      const existing = state.nameSuggestions[voiceId];
      const sameName = existing?.name.trim().toLowerCase() === event.name.trim().toLowerCase();
      // A restatement of the same name replaces its slot as the evidence accumulates;
      // a rival name has to actually beat it to take the slot.
      if (existing && !sameName && event.confidence <= existing.confidence) return state;
      if (existing && sameName
        && existing.confidence === event.confidence
        && existing.evidence === event.evidence) return state;

      return {
        ...state,
        nameSuggestions: {
          ...state.nameSuggestions,
          [voiceId]: {
            voice_id: voiceId,
            conversation_id: event.conversation_id,
            name: event.name.trim(),
            confidence: event.confidence,
            evidence: event.evidence,
            evidence_utterance_id: event.evidence_utterance_id,
            kind: event.kind,
          },
        },
      };
    }

    case 'identity': {
      const existing = state.people[event.person_id];
      // A name the owner set, or one the server confirmed, is settled. Only those two
      // outrank an incoming claim.
      const settled = Boolean(existing && !isUnnamed(existing) && !existing.provisional);
      // 'pending' carries no usable name yet, so it must not overwrite one we have.
      const claimUsable = event.confidence !== 'pending' && !isUnnamed({ name: event.name });
      const person: PersonRecord = {
        _id: event.person_id,
        owner_id: OWNER_ID,
        name: settled || !claimUsable ? existing?.name ?? event.name : event.name,
        // Attribution that is not sure is rendered as a guess, never as a plain name.
        provisional: settled ? false : claimUsable ? event.confidence === 'provisional' : existing?.provisional,
        relationship: existing?.relationship,
        is_owner: existing?.is_owner,
        voiceprint_id: event.voiceprint_id ?? existing?.voiceprint_id,
        created_at: existing?.created_at ?? nowIso,
        updated_at: nowIso,
      };
      const utterances = { ...state.utterances };
      const attributing = { ...state.attributing };
      for (const utteranceId of event.utterance_ids) {
        delete attributing[utteranceId];
        const utterance = utterances[utteranceId];
        if (!utterance) continue;
        utterances[utteranceId] = {
          ...utterance,
          person_id: event.person_id,
          voiceprint_id: event.voiceprint_id ?? utterance.voiceprint_id,
          updated_at: nowIso,
        };
      }
      const conversation = ensureConversation(state, event.conversation_id, nowIso);
      return {
        ...state,
        people: { ...state.people, [person._id]: person },
        utterances,
        attributing,
        conversations: {
          ...state.conversations,
          [conversation._id]: {
            ...conversation,
            participant_ids: conversation.participant_ids.includes(person._id)
              ? conversation.participant_ids
              : [...conversation.participant_ids, person._id],
          },
        },
      };
    }

    case 'fact': {
      const previous = state.facts[event.fact_id];
      const live = liveConversationId(state.recording);
      // Fact events stay small, so reconnect the fact to the finalized turn that
      // immediately preceded extraction. Persisted facts already carry this id.
      const inferredSource = Object.values(state.utterances)
        .filter((utterance) => (
          utterance.is_final
          && utterance.person_id === event.person_id
          && (!live || utterance.conversation_id === live)
        ))
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.end_ms - a.end_ms)[0];
      const fact: Fact = {
        _id: event.fact_id,
        owner_id: OWNER_ID,
        person_id: event.person_id,
        attribute: event.attribute,
        claim: event.claim,
        claim_normalized: event.claim.toLowerCase(),
        primary_source_utterance_id: previous?.primary_source_utterance_id ?? inferredSource?._id ?? '',
        valid_from: previous?.valid_from ?? nowIso,
        created_at: previous?.created_at ?? nowIso,
      };
      const facts = { ...state.facts, [fact._id]: fact };
      if (event.superseded_fact_id && facts[event.superseded_fact_id]) {
        facts[event.superseded_fact_id] = {
          ...facts[event.superseded_fact_id],
          superseded_at: nowIso,
          superseded_by: fact._id,
        };
      }
      return { ...state, facts };
    }

    case 'promise': {
      const previous = state.promises[event.promise_id];
      const promise: PromiseMemory = {
        _id: event.promise_id,
        owner_id: OWNER_ID,
        person_id: event.person_id,
        source_utterance_id: previous?.source_utterance_id ?? '',
        text: event.text,
        text_normalized: event.text.toLowerCase(),
        due_at: event.due_at ?? previous?.due_at,
        // A close the owner just made outranks the server's copy until the write lands.
        status: state.promiseWrites[event.promise_id] ?? event.status,
        created_at: previous?.created_at ?? nowIso,
      };
      return { ...state, promises: { ...state.promises, [promise._id]: promise } };
    }

    case 'presence':
      return { ...state, presence: applyPresenceEvent(state.presence, event, Date.now()) };

    case 'identity_conflict': {
      const key = `${event.face_person_id}:${event.voice_person_id}`;
      if (state.identityConflicts[key]) return state;
      return { ...state, identityConflicts: { ...state.identityConflicts, [key]: event } };
    }

    case 'amelia_step':
      return withAmeliaTurn(state, event.request_id, (turn) => ({
        ...turn,
        steps: [...turn.steps, { step: event.step, message: event.message }],
        done: event.step === 'denied' || event.step === 'error',
      }));

    case 'amelia_audio':
      return withAmeliaTurn(state, event.request_id, (turn) => ({
        ...turn,
        reply: event.text,
        audio_url: event.audio_url,
        done: true,
      }));

    default:
      return state;
  }
}

/** Exposed so the event rules can be tested without mounting the app. */
export function applyEvents(state: AmeliaState, events: AmeliaEvent[]): AmeliaState {
  return events.reduce(applyEvent, state);
}

export function reduce(state: AmeliaState, action: Action): AmeliaState {
  switch (action.kind) {
    /**
     * Consecutive utterance events are folded together, so a burst of turns arriving in
     * one debounced batch costs a single pass rather than one whole-map clone each.
     * Runs are kept in order, so an identity event still sees exactly the turns that
     * preceded it.
     */
    case 'events': {
      let next = state;
      let run: IncomingUtterance[] = [];
      const flush = () => {
        if (run.length === 0) return;
        next = mergeUtterances(next, run, new Date().toISOString());
        run = [];
      };
      for (const event of action.events) {
        if (event.type === 'utterance') run.push(event);
        else {
          flush();
          next = applyEvent(next, event);
        }
      }
      flush();
      return next;
    }

    /**
     * Hydration is history arriving, not a turn happening. Routing it through the same
     * path as live events is what used to stamp an old conversation as the most recent
     * one, so Amelia's first answer after a cold start landed on a random transcript.
     */
    case 'hydrate-utterances':
      return mergeUtterances(state, action.utterances.map((utterance) => ({
        utterance_id: utterance._id,
        conversation_id: utterance.conversation_id,
        person_id: utterance.person_id,
        voiceprint_id: utterance.voiceprint_id,
        text: utterance.text,
        start_ms: utterance.start_ms,
        end_ms: utterance.end_ms,
        is_final: utterance.is_final,
      })), new Date().toISOString());

    /**
     * Names a voice, creating the record when there is not one yet. The early return
     * on "no such person" was exactly backwards: a speaker Amelia never resolved is
     * the case the naming sheet exists for, and dropping it lost the relationship and
     * the owner flag along with the name.
     */
    case 'name-person': {
      const nowIso = new Date().toISOString();
      const existing = state.people[action.personId];
      const people = { ...state.people };
      // Only one person can be the owner, so claiming it releases whoever held it.
      if (action.isOwner) {
        for (const [id, person] of Object.entries(people)) {
          if (person.is_owner && id !== action.personId) people[id] = { ...person, is_owner: false };
        }
      }
      people[action.personId] = {
        _id: action.personId,
        owner_id: existing?.owner_id ?? OWNER_ID,
        name: action.name.trim(),
        // The owner naming a voice settles it. Nothing inferred downgrades it after.
        provisional: false,
        relationship: action.relationship?.trim() || existing?.relationship,
        is_owner: action.isOwner ?? existing?.is_owner,
        voiceprint_id: action.voiceprintId ?? existing?.voiceprint_id,
        created_at: existing?.created_at ?? nowIso,
        updated_at: nowIso,
      };
      // The question has been answered, however it was answered.
      return { ...state, people, nameSuggestions: omit(state.nameSuggestions, action.personId) };
    }

    /** Puts a person back exactly as they were when the server refused the change. */
    case 'revert-person': {
      const people = { ...state.people };
      if (action.person) people[action.personId] = action.person;
      else delete people[action.personId];
      return { ...state, people };
    }

    /**
     * One voice, one person. Two code paths used to mint different ids for the same
     * speaker, so naming them twice produced twins; merging re-points everything at
     * the surviving record the way the server does.
     */
    case 'merge-people': {
      const keep = state.people[action.keepId];
      if (!keep) return state;
      const mergedIds = action.mergedIds.filter((id) => id !== action.keepId && state.people[id]);
      if (mergedIds.length === 0) return state;
      const merged = new Set(mergedIds);

      const people = { ...state.people };
      for (const id of mergedIds) delete people[id];

      const repoint = <T extends { person_id?: Id }>(record: Record<Id, T>): Record<Id, T> => {
        let changed = false;
        const next: Record<Id, T> = {};
        for (const [id, item] of Object.entries(record)) {
          if (item.person_id && merged.has(item.person_id)) {
            next[id] = { ...item, person_id: action.keepId };
            changed = true;
          } else next[id] = item;
        }
        return changed ? next : record;
      };

      const conversations: Record<Id, Conversation> = {};
      for (const [id, conversation] of Object.entries(state.conversations)) {
        const participants = conversation.participant_ids.map((pid) => (merged.has(pid) ? action.keepId : pid));
        conversations[id] = participants.some((pid, index) => pid !== conversation.participant_ids[index])
          ? { ...conversation, participant_ids: [...new Set(participants)] }
          : conversation;
      }

      const avatars = { ...state.avatars };
      const nameSuggestions = { ...state.nameSuggestions };
      for (const id of mergedIds) {
        if (avatars[id] && !avatars[action.keepId]) avatars[action.keepId] = avatars[id];
        delete avatars[id];
        delete nameSuggestions[id];
      }

      return {
        ...state,
        people,
        avatars,
        nameSuggestions,
        conversations,
        utterances: repoint(state.utterances),
        facts: repoint(state.facts),
        promises: repoint(state.promises),
      };
    }

    case 'set-avatar':
      return { ...state, avatars: { ...state.avatars, [action.personId]: action.uri } };

    /** Optimistic. The write is registered so nothing inbound can undo it in flight. */
    case 'set-promise-status': {
      const existing = state.promises[action.promiseId];
      if (!existing) return state;
      return {
        ...state,
        promises: { ...state.promises, [action.promiseId]: { ...existing, status: action.status } },
        promiseWrites: { ...state.promiseWrites, [action.promiseId]: action.status },
      };
    }

    /**
     * The server answered. Its record is authoritative from here, and the guard comes
     * off so ordinary events flow again.
     */
    case 'settle-promise-status': {
      const existing = state.promises[action.promiseId];
      const promise = action.promise && existing
        ? { ...existing, ...action.promise }
        : action.promise ?? existing;
      return {
        ...state,
        promises: promise ? { ...state.promises, [action.promiseId]: promise } : state.promises,
        promiseWrites: omit(state.promiseWrites, action.promiseId),
      };
    }

    /** The server refused the change, so the checkbox goes back to where it was. */
    case 'revert-promise-status': {
      const existing = state.promises[action.promiseId];
      return {
        ...state,
        promises: existing
          ? { ...state.promises, [action.promiseId]: { ...existing, status: action.status } }
          : state.promises,
        promiseWrites: omit(state.promiseWrites, action.promiseId),
      };
    }

    /**
     * Promises pulled from GET /promises. Loops was empty on a cold start because they
     * only ever arrived over the bus. A promise with a write in flight keeps the
     * owner's status; everything else the server says is taken as-is.
     */
    case 'hydrate-promises': {
      const promises = { ...state.promises };
      let changed = false;
      for (const incoming of action.promises) {
        const pending = state.promiseWrites[incoming._id];
        const next = pending ? { ...incoming, status: pending } : incoming;
        const existing = promises[incoming._id];
        if (existing
          && existing.status === next.status
          && existing.text === next.text
          && existing.due_at === next.due_at
          && existing.person_id === next.person_id) continue;
        promises[incoming._id] = next;
        changed = true;
      }
      return changed ? { ...state, promises } : state;
    }

    /**
     * Removes the conversation, its turns, and the facts and promises that cite them —
     * which is what the confirmation copy has always promised. Everything removed is
     * kept aside so a server refusal can put it back instead of resurrecting it on the
     * next hydrate.
     */
    case 'delete-conversation': {
      const conversation = state.conversations[action.conversationId];
      const utterances: Utterance[] = [];
      const keptUtterances: Record<Id, Utterance> = {};
      for (const [id, utterance] of Object.entries(state.utterances)) {
        if (utterance.conversation_id === action.conversationId) utterances.push(utterance);
        else keptUtterances[id] = utterance;
      }
      const removedUtteranceIds = new Set(utterances.map((utterance) => utterance._id));

      const facts: Fact[] = [];
      const keptFacts: Record<Id, Fact> = {};
      for (const [id, fact] of Object.entries(state.facts)) {
        if (removedUtteranceIds.has(fact.primary_source_utterance_id)) facts.push(fact);
        else keptFacts[id] = fact;
      }

      const promises: PromiseMemory[] = [];
      const keptPromises: Record<Id, PromiseMemory> = {};
      for (const [id, promise] of Object.entries(state.promises)) {
        if (removedUtteranceIds.has(promise.source_utterance_id)) promises.push(promise);
        else keptPromises[id] = promise;
      }

      const conversations = { ...state.conversations };
      delete conversations[action.conversationId];

      const stillLive = liveConversationId(state.recording) === action.conversationId;

      return {
        ...state,
        conversations,
        utterances: keptUtterances,
        facts: keptFacts,
        promises: keptPromises,
        recording: stillLive ? recordingReducer(state.recording, { type: 'stop' }) : state.recording,
        deleted: { ...state.deleted, [action.conversationId]: { conversation, utterances, facts, promises } },
      };
    }

    case 'undo-delete-conversation': {
      const snapshot = state.deleted[action.conversationId];
      if (!snapshot) return state;
      return {
        ...state,
        conversations: snapshot.conversation
          ? { ...state.conversations, [action.conversationId]: snapshot.conversation }
          : state.conversations,
        utterances: { ...state.utterances, ...byId(snapshot.utterances) },
        facts: { ...state.facts, ...byId(snapshot.facts) },
        promises: { ...state.promises, ...byId(snapshot.promises) },
        deleted: omit(state.deleted, action.conversationId),
      };
    }

    case 'forget-deleted':
      return { ...state, deleted: omit(state.deleted, action.conversationId) };

    case 'rename-conversation': {
      const existing = state.conversations[action.conversationId];
      if (!existing) return state;
      const title = action.title.trim();
      return {
        ...state,
        conversations: {
          ...state.conversations,
          [action.conversationId]: { ...existing, title: title || existing.title },
        },
        // Remember it was hand-titled so the model's generated name cannot land on top.
        renamedConversations: title
          ? { ...state.renamedConversations, [action.conversationId]: true as const }
          : state.renamedConversations,
      };
    }

    /**
     * Naming a speaker Amelia never resolved has to attach the person to their turns
     * ourselves — there is no voiceprint to match on, so nothing on the server can do it.
     */
    case 'attribute-utterances': {
      const utterances = { ...state.utterances };
      const attributing = { ...state.attributing };
      const nowIso = new Date().toISOString();
      let conversationId: Id | null = null;
      for (const id of action.utteranceIds) {
        const utterance = utterances[id];
        if (!utterance) continue;
        conversationId = utterance.conversation_id;
        delete attributing[id];
        utterances[id] = { ...utterance, person_id: action.personId, updated_at: nowIso };
      }
      if (!conversationId) return state;
      const conversation = state.conversations[conversationId];
      return {
        ...state,
        utterances,
        attributing,
        conversations: conversation
          ? {
              ...state.conversations,
              [conversationId]: {
                ...conversation,
                participant_ids: conversation.participant_ids.includes(action.personId)
                  ? conversation.participant_ids
                  : [...conversation.participant_ids, action.personId],
              },
            }
          : state.conversations,
      };
    }

    /** Server records are authoritative for identity and start time; local titles win. */
    case 'upsert-conversations': {
      const conversations = { ...state.conversations };
      const serverConversations = { ...state.serverConversations };
      let changed = false;
      for (const incoming of action.conversations) {
        // A conversation the owner just deleted must not come back on the next poll.
        if (state.deleted[incoming._id]) continue;
        if (!serverConversations[incoming._id]) {
          serverConversations[incoming._id] = true;
          changed = true;
        }
        const existing = conversations[incoming._id];
        const ownerTitled = state.renamedConversations[incoming._id];
        const next: Conversation = {
          ...incoming,
          title: (ownerTitled ? existing?.title : incoming.title ?? existing?.title)
            ?? titleFor(incoming.started_at),
          participant_ids: existing?.participant_ids?.length
            ? existing.participant_ids
            : incoming.participant_ids ?? [],
        };
        if (existing
          && existing.title === next.title
          && existing.started_at === next.started_at
          && existing.ended_at === next.ended_at
          && existing.participant_ids === next.participant_ids) continue;
        conversations[incoming._id] = next;
        changed = true;
      }
      return changed ? { ...state, conversations, serverConversations } : state;
    }

    /**
     * Utterances carry a person_id, but without the person record behind it every speaker
     * renders as "Unknown speaker". Names the owner set locally are never overwritten by a
     * server record that has not caught up.
     */
    case 'upsert-people': {
      const people = { ...state.people };
      let changed = false;
      for (const incoming of action.people) {
        const existing = people[incoming._id];
        const next: PersonRecord = {
          ...existing,
          ...incoming,
          name: existing && !isUnnamed(existing) ? existing.name : incoming.name,
          voiceprint_id: existing?.voiceprint_id,
        };
        if (existing
          && existing.name === next.name
          && existing.relationship === next.relationship
          && existing.is_owner === next.is_owner
          && existing.voiceprint_id === next.voiceprint_id
          // A new face crop and a fresh sighting are both things a card renders.
          && existing.avatar_thumbnail === next.avatar_thumbnail
          && existing.last_seen_at === next.last_seen_at) continue;
        people[incoming._id] = next;
        changed = true;
      }
      return changed ? { ...state, people } : state;
    }

    case 'hydrate-avatars':
      return { ...state, avatars: { ...action.avatars, ...state.avatars } };

    /**
     * Turning a suggestion down sticks for the session, but only for this name. The
     * room may well say a different one in five minutes, and that is worth asking about.
     */
    case 'dismiss-name-suggestion':
      return {
        ...state,
        nameSuggestions: omit(state.nameSuggestions, action.voiceId),
        dismissedSuggestions: {
          ...state.dismissedSuggestions,
          [suggestionKey(action.voiceId, action.name)]: true as const,
        },
      };

    case 'dismiss-unknown-card':
      return { ...state, unknownCardDismissed: true };

    case 'recording': {
      const recording = recordingReducer(state.recording, action.event);
      return recording === state.recording ? state : { ...state, recording };
    }

    /** Gives up on an answer that is never coming, rather than pulsing forever. */
    case 'expire-attributions': {
      const attributing: Record<Id, AttributionWait> = {};
      let changed = false;
      for (const [id, waiting] of Object.entries(state.attributing)) {
        if (action.now - waiting.since < ATTRIBUTION_TIMEOUT_MS) attributing[id] = waiting;
        else changed = true;
      }
      return changed ? { ...state, attributing } : state;
    }

    case 'set-connection':
      return state.connection === action.source ? state : { ...state, connection: action.source };

    /** Cards for people who left. Returns the same state when nobody has. */
    case 'sweep-presence': {
      const presence = sweepPresence(state.presence, action.now);
      return presence === state.presence ? state : { ...state, presence };
    }

    case 'glasses': {
      const glasses = glassesReducer(state.glasses, action.event);
      return glasses === state.glasses ? state : { ...state, glasses };
    }

    case 'notice': {
      // One notice per message: a failing poll must not stack twenty identical banners.
      if (state.notices.some((notice) => notice.message === action.notice.message)) return state;
      return { ...state, notices: [...state.notices, action.notice].slice(-3) };
    }

    case 'dismiss-notice': {
      const notices = state.notices.filter((notice) => notice.id !== action.id);
      return notices.length === state.notices.length ? state : { ...state, notices };
    }

    default:
      return state;
  }
}

export { DEMO_CONVERSATION_ID };
