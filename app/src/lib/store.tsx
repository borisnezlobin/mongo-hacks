import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react';
import type {
  AmeliaEvent,
  Conversation,
  Fact,
  Id,
  Person,
  PromiseMemory,
  Utterance,
} from '../../../shared/contracts';
import { OWNER_ID, SSE_DEBOUNCE_MS } from '../../../shared/contracts';
import {
  DEMO_CONVERSATION_ID,
  OWNER_PERSON_ID,
  seedConversations,
  seedFacts,
  seedPeople,
  seedPromises,
  seedUtterances,
} from './seed';

export interface PersonRecord extends Person {
  avatar_uri?: string;
  voiceprint_id?: Id;
}

export interface AmeliaTurn {
  request_id: Id;
  steps: { step: string; message: string }[];
  reply?: string;
  audio_url?: string;
  conversation_id?: Id;
  done: boolean;
}

export interface AmeliaState {
  people: Record<Id, PersonRecord>;
  facts: Record<Id, Fact>;
  promises: Record<Id, PromiseMemory>;
  utterances: Record<Id, Utterance>;
  conversations: Record<Id, Conversation>;
  amelia: AmeliaTurn | null;
  liveConversationId: Id | null;
  unknownCardDismissed: boolean;
}

type Action =
  | { kind: 'events'; events: AmeliaEvent[] }
  | { kind: 'name-person'; personId: Id; name: string; relationship?: string; isOwner?: boolean }
  | { kind: 'set-avatar'; personId: Id; uri: string }
  | { kind: 'close-promise'; promiseId: Id }
  | { kind: 'reopen-promise'; promiseId: Id }
  | { kind: 'rename-conversation'; conversationId: Id; title: string }
  | { kind: 'dismiss-unknown-card' }
  | { kind: 'set-live-conversation'; conversationId: Id | null }
  | { kind: 'attribute-utterances'; utteranceIds: Id[]; personId: Id };

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

function byId<T extends { _id: Id }>(items: T[]): Record<Id, T> {
  return Object.fromEntries(items.map((item) => [item._id, item]));
}

export function createInitialState(): AmeliaState {
  return {
    people: byId(seedPeople as PersonRecord[]),
    facts: byId(seedFacts),
    promises: byId(seedPromises),
    utterances: byId(seedUtterances),
    conversations: byId(seedConversations),
    amelia: null,
    liveConversationId: null,
    unknownCardDismissed: false,
  };
}

function ensureConversation(state: AmeliaState, conversationId: Id, timestamp: string): Conversation {
  return (
    state.conversations[conversationId] ?? {
      _id: conversationId,
      owner_id: OWNER_ID,
      started_at: timestamp,
      title: `Conversation, ${new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`,
      participant_ids: [],
    }
  );
}

function applyEvent(state: AmeliaState, event: AmeliaEvent): AmeliaState {
  const nowIso = new Date().toISOString();

  switch (event.type) {
    case 'utterance': {
      // Contract rule: re-emitting the same utterance_id replaces the earlier revision.
      const previous = state.utterances[event.utterance_id];
      const utterance: Utterance = {
        _id: event.utterance_id,
        owner_id: OWNER_ID,
        conversation_id: event.conversation_id,
        person_id: event.person_id,
        voiceprint_id: event.voiceprint_id,
        text: event.text,
        start_ms: event.start_ms,
        end_ms: event.end_ms,
        is_final: event.is_final,
        created_at: previous?.created_at ?? nowIso,
        updated_at: nowIso,
      };
      const conversation = ensureConversation(state, event.conversation_id, nowIso);
      const participants = event.person_id && !conversation.participant_ids.includes(event.person_id)
        ? [...conversation.participant_ids, event.person_id]
        : conversation.participant_ids;
      return {
        ...state,
        utterances: { ...state.utterances, [utterance._id]: utterance },
        conversations: {
          ...state.conversations,
          [conversation._id]: { ...conversation, participant_ids: participants },
        },
        liveConversationId: event.conversation_id,
      };
    }

    case 'identity': {
      const existing = state.people[event.person_id];
      const person: PersonRecord = {
        _id: event.person_id,
        owner_id: OWNER_ID,
        // A later identity event never blanks a name the owner already gave.
        name: existing && !isUnnamed(existing) ? existing.name : event.name,
        relationship: existing?.relationship,
        is_owner: existing?.is_owner,
        avatar_uri: existing?.avatar_uri,
        voiceprint_id: event.voiceprint_id ?? existing?.voiceprint_id,
        created_at: existing?.created_at ?? nowIso,
        updated_at: nowIso,
      };
      const utterances = { ...state.utterances };
      for (const utteranceId of event.utterance_ids) {
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
      const fact: Fact = {
        _id: event.fact_id,
        owner_id: OWNER_ID,
        person_id: event.person_id,
        attribute: event.attribute,
        claim: event.claim,
        claim_normalized: event.claim.toLowerCase(),
        primary_source_utterance_id: previous?.primary_source_utterance_id ?? '',
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
        status: event.status,
        created_at: previous?.created_at ?? nowIso,
      };
      return { ...state, promises: { ...state.promises, [promise._id]: promise } };
    }

    case 'amelia_step': {
      const turn: AmeliaTurn =
        state.amelia && state.amelia.request_id === event.request_id
          ? state.amelia
          : { request_id: event.request_id, steps: [], done: false, conversation_id: state.liveConversationId ?? undefined };
      return {
        ...state,
        amelia: {
          ...turn,
          steps: [...turn.steps, { step: event.step, message: event.message }],
          done: event.step === 'denied' || event.step === 'error',
        },
      };
    }

    case 'amelia_audio': {
      const turn: AmeliaTurn =
        state.amelia && state.amelia.request_id === event.request_id
          ? state.amelia
          : { request_id: event.request_id, steps: [], done: false, conversation_id: state.liveConversationId ?? undefined };
      return {
        ...state,
        amelia: { ...turn, reply: event.text, audio_url: event.audio_url, done: true },
      };
    }

    default:
      return state;
  }
}

/** Exposed so the event rules can be tested without mounting the app. */
export function applyEvents(state: AmeliaState, events: AmeliaEvent[]): AmeliaState {
  return events.reduce(applyEvent, state);
}

function reducer(state: AmeliaState, action: Action): AmeliaState {
  switch (action.kind) {
    case 'events':
      return action.events.reduce(applyEvent, state);

    case 'name-person': {
      const existing = state.people[action.personId];
      if (!existing) return state;
      const people = { ...state.people };
      // Only one person can be the owner, so claiming it releases whoever held it.
      if (action.isOwner) {
        for (const [id, person] of Object.entries(people)) {
          if (person.is_owner && id !== action.personId) people[id] = { ...person, is_owner: false };
        }
      }
      people[action.personId] = {
        ...existing,
        name: action.name.trim(),
        relationship: action.relationship?.trim() || existing.relationship,
        is_owner: action.isOwner ?? existing.is_owner,
        updated_at: new Date().toISOString(),
      };
      return { ...state, people };
    }

    case 'set-avatar': {
      const existing = state.people[action.personId];
      if (!existing) return state;
      return {
        ...state,
        people: { ...state.people, [action.personId]: { ...existing, avatar_uri: action.uri } },
      };
    }

    case 'close-promise':
    case 'reopen-promise': {
      const existing = state.promises[action.promiseId];
      if (!existing) return state;
      const status: PromiseMemory['status'] = action.kind === 'close-promise' ? 'done' : 'open';
      return { ...state, promises: { ...state.promises, [action.promiseId]: { ...existing, status } } };
    }

    case 'rename-conversation': {
      const existing = state.conversations[action.conversationId];
      if (!existing) return state;
      return {
        ...state,
        conversations: {
          ...state.conversations,
          [action.conversationId]: { ...existing, title: action.title.trim() || existing.title },
        },
      };
    }

    /**
     * Naming a speaker Amelia never resolved has to attach the person to their turns
     * ourselves — there is no voiceprint to match on, so nothing on the server can do it.
     * Without this, naming updated a person record no utterance referenced and the
     * transcript kept saying "Unknown speaker".
     */
    case 'attribute-utterances': {
      const utterances = { ...state.utterances };
      const nowIso = new Date().toISOString();
      let conversationId: Id | null = null;
      for (const id of action.utteranceIds) {
        const utterance = utterances[id];
        if (!utterance) continue;
        conversationId = utterance.conversation_id;
        utterances[id] = { ...utterance, person_id: action.personId, updated_at: nowIso };
      }
      if (!conversationId) return state;
      const conversation = state.conversations[conversationId];
      return {
        ...state,
        utterances,
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

    case 'dismiss-unknown-card':
      return { ...state, unknownCardDismissed: true };

    case 'set-live-conversation':
      return { ...state, liveConversationId: action.conversationId };

    default:
      return state;
  }
}

interface StoreValue {
  state: AmeliaState;
  ingest(event: AmeliaEvent): void;
  namePerson(personId: Id, name: string, relationship?: string, isOwner?: boolean): void;
  setAvatar(personId: Id, uri: string): void;
  closePromise(promiseId: Id): void;
  reopenPromise(promiseId: Id): void;
  renameConversation(conversationId: Id, title: string): void;
  dismissUnknownCard(): void;
  attributeUtterances(utteranceIds: Id[], personId: Id): void;
  setLiveConversation(conversationId: Id | null): void;
}

const StoreContext = createContext<StoreValue | null>(null);

export function AmeliaStoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, createInitialState);
  const queue = useRef<AmeliaEvent[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  // `ingest` must be referentially stable: it is an effect dependency in the conversation
  // view, and rebuilding it on every state change turned a one-shot hydrate into an
  // infinite fetch loop (which looked like the transcript scrolling on its own).
  const ingest = useCallback((event: AmeliaEvent) => {
    queue.current.push(event);
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      const events = queue.current;
      queue.current = [];
      if (events.length > 0) dispatch({ kind: 'events', events });
    }, SSE_DEBOUNCE_MS);
  }, []);

  const value = useMemo<StoreValue>(() => ({
    state,
    ingest,
    namePerson: (personId, name, relationship, isOwner) => dispatch({ kind: 'name-person', personId, name, relationship, isOwner }),
    setAvatar: (personId, uri) => dispatch({ kind: 'set-avatar', personId, uri }),
    closePromise: (promiseId) => dispatch({ kind: 'close-promise', promiseId }),
    reopenPromise: (promiseId) => dispatch({ kind: 'reopen-promise', promiseId }),
    renameConversation: (conversationId, title) => dispatch({ kind: 'rename-conversation', conversationId, title }),
    dismissUnknownCard: () => dispatch({ kind: 'dismiss-unknown-card' }),
    attributeUtterances: (utteranceIds, personId) => dispatch({ kind: 'attribute-utterances', utteranceIds, personId }),
    setLiveConversation: (conversationId) => dispatch({ kind: 'set-live-conversation', conversationId }),
  }), [state, ingest]);

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
  const value = useContext(StoreContext);
  if (!value) throw new Error('useStore must be used inside AmeliaStoreProvider');
  return value;
}

export function usePeople(): PersonRecord[] {
  const { state } = useStore();
  return useMemo(
    () => Object.values(state.people).sort((a, b) => displayName(a).localeCompare(displayName(b))),
    [state.people],
  );
}

export function useUnknownPeople(): PersonRecord[] {
  const { state } = useStore();
  return useMemo(() => Object.values(state.people).filter(isUnnamed), [state.people]);
}

export function useCurrentFacts(personId: Id | undefined): Fact[] {
  const { state } = useStore();
  return useMemo(() => {
    if (!personId) return [];
    return Object.values(state.facts)
      .filter((fact) => fact.person_id === personId && !fact.superseded_by)
      .sort((a, b) => b.valid_from.localeCompare(a.valid_from));
  }, [state.facts, personId]);
}

export function useSupersededFacts(personId: Id | undefined): Fact[] {
  const { state } = useStore();
  return useMemo(() => {
    if (!personId) return [];
    return Object.values(state.facts)
      .filter((fact) => fact.person_id === personId && Boolean(fact.superseded_by))
      .sort((a, b) => b.valid_from.localeCompare(a.valid_from));
  }, [state.facts, personId]);
}

export function usePromisesFor(personId: Id | undefined): PromiseMemory[] {
  const { state } = useStore();
  return useMemo(() => {
    if (!personId) return [];
    return Object.values(state.promises).filter((promise) => promise.person_id === personId);
  }, [state.promises, personId]);
}

export function useConversationUtterances(conversationId: Id | undefined): Utterance[] {
  const { state } = useStore();
  return useMemo(() => {
    if (!conversationId) return [];
    return Object.values(state.utterances)
      .filter((utterance) => utterance.conversation_id === conversationId)
      .sort((a, b) => a.start_ms - b.start_ms);
  }, [state.utterances, conversationId]);
}

export function useConversations(): Conversation[] {
  const { state } = useStore();
  return useMemo(
    () => Object.values(state.conversations).sort((a, b) => b.started_at.localeCompare(a.started_at)),
    [state.conversations],
  );
}

export { DEMO_CONVERSATION_ID, OWNER_PERSON_ID };
