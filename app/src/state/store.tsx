import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { AmeliaEvent, Conversation, Id, Person, PromiseMemory, Utterance } from '../../../shared/contracts';
import { SSE_DEBOUNCE_MS } from '../../../shared/contracts';
import { api, ApiError } from '../lib/api';
import type { RecordingEvent } from './recording';
import {
  ATTRIBUTION_TIMEOUT_MS,
  createInitialState,
  isUnnamed,
  reduce,
  type Action,
  type AmeliaState,
  type ConnectionSource,
  type PersonRecord,
} from './reducer';

/**
 * The store is an external store, not a context value that changes.
 *
 * The provider used to hand every consumer `{ state, ...actions }` memoized on `[state]`,
 * so a single utterance re-rendered every screen in the tree. Here the context value is
 * created once and never changes; components subscribe to the slice they read and are
 * woken only when that slice actually differs.
 */

export interface StoreHandle {
  getState(): AmeliaState;
  subscribe(listener: () => void): () => void;
  dispatch(action: Action): void;
}

function createStore(initial: AmeliaState): StoreHandle {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatch(action) {
      const next = reduce(state, action);
      if (next === state) return;
      state = next;
      for (const listener of listeners) listener();
    },
  };
}

const StoreContext = createContext<StoreHandle | null>(null);
const ActionsContext = createContext<Actions | null>(null);

export function useStoreHandle(): StoreHandle {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useStoreHandle must be used inside AmeliaStoreProvider');
  return store;
}

/**
 * Subscribes to one derived value. `equals` decides what counts as a change, so a
 * selector that rebuilds an array on every tick still does not re-render its caller
 * when the contents are the same objects.
 */
export function useSelector<T>(
  selector: (state: AmeliaState) => T,
  equals: (a: T, b: T) => boolean = Object.is,
): T {
  const store = useStoreHandle();
  const cache = useRef<{ state: AmeliaState; value: T } | null>(null);

  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const equalsRef = useRef(equals);
  equalsRef.current = equals;

  const getSnapshot = useCallback(() => {
    const state = store.getState();
    const cached = cache.current;
    if (cached && cached.state === state) return cached.value;
    const value = selectorRef.current(state);
    if (cached && equalsRef.current(cached.value, value)) {
      cache.current = { state, value: cached.value };
      return cached.value;
    }
    cache.current = { state, value };
    return value;
  }, [store]);

  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

export function useActions(): Actions {
  const actions = useContext(ActionsContext);
  if (!actions) throw new Error('useActions must be used inside AmeliaStoreProvider');
  return actions;
}

let noticeCounter = 0;
function noticeId(): string {
  noticeCounter += 1;
  return `n-${noticeCounter}`;
}

/**
 * A rejection is the server saying no; anything else is the server being unreachable.
 * Only the first is worth undoing the owner's edit for — throwing away a name because
 * the wifi dropped, or because the speaker only exists on this phone, is worse than
 * keeping it and saying so.
 */
function isRejection(error: unknown): boolean {
  return error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 404;
}

export interface Actions {
  /** Live bus events, debounced into batches. */
  ingest(event: AmeliaEvent): void;
  hydrateUtterances(utterances: Utterance[]): void;
  upsertConversations(conversations: Conversation[]): void;
  upsertPeople(people: Person[]): void;
  hydrateAvatars(avatars: Record<Id, string>): void;
  namePerson(input: {
    personId: Id;
    name: string;
    relationship?: string;
    isOwner?: boolean;
    voiceprintId?: Id;
    utteranceIds?: Id[];
  }): Promise<void>;
  setAvatar(personId: Id, uri: string): void;
  attributeUtterances(utteranceIds: Id[], personId: Id): void;
  setPromiseStatus(promiseId: Id, status: PromiseMemory['status']): Promise<void>;
  hydratePromises(promises: PromiseMemory[]): void;
  scheduleReminder(promise: PromiseMemory): Promise<void>;
  renameConversation(conversationId: Id, title: string): void;
  deleteConversation(conversationId: Id): Promise<void>;
  dismissNameSuggestion(voiceId: Id, name: string): void;
  dismissUnknownCard(): void;
  recording(event: RecordingEvent): void;
  setConnection(source: ConnectionSource): void;
  notify(message: string, tone?: 'error' | 'info'): void;
  dismissNotice(id: string): void;
}

function createActions(store: StoreHandle, queue: { events: AmeliaEvent[]; timer: ReturnType<typeof setTimeout> | null }): Actions {
  const notify = (message: string, tone: 'error' | 'info' = 'error') =>
    store.dispatch({ kind: 'notice', notice: { id: noticeId(), message, tone } });

  return {
    ingest(event) {
      queue.events.push(event);
      if (queue.timer) return;
      queue.timer = setTimeout(() => {
        queue.timer = null;
        const events = queue.events;
        queue.events = [];
        if (events.length > 0) store.dispatch({ kind: 'events', events });
      }, SSE_DEBOUNCE_MS);
    },

    hydrateUtterances: (utterances) => store.dispatch({ kind: 'hydrate-utterances', utterances }),
    upsertConversations: (conversations) => store.dispatch({ kind: 'upsert-conversations', conversations }),
    upsertPeople: (people) => store.dispatch({ kind: 'upsert-people', people }),
    hydrateAvatars: (avatars) => store.dispatch({ kind: 'hydrate-avatars', avatars }),

    /**
     * Optimistic, then persisted. Naming used to be local only, so a name vanished on
     * reload; now the record is written straight away and the server call either
     * confirms it or the owner is told it did not stick.
     */
    async namePerson({ personId, name, relationship, isOwner, voiceprintId, utteranceIds }) {
      const before = store.getState().people[personId] ?? null;
      store.dispatch({ kind: 'name-person', personId, name, relationship, isOwner, voiceprintId });
      if (utteranceIds && utteranceIds.length > 0) {
        store.dispatch({ kind: 'attribute-utterances', utteranceIds, personId });
      }

      // The same voice named twice is one person, not twins. Fold the duplicate into
      // the older record the way the server's merge does.
      const trimmed = name.trim().toLowerCase();
      const twin = Object.values(store.getState().people).find((person) => (
        person._id !== personId
        && !isUnnamed(person)
        && person.name.trim().toLowerCase() === trimmed
      ));
      const keepId = twin
        ? (twin.created_at <= (before?.created_at ?? new Date().toISOString()) ? twin._id : personId)
        : personId;
      if (twin) {
        const mergedIds = [twin._id, personId].filter((id) => id !== keepId);
        store.dispatch({ kind: 'merge-people', keepId, mergedIds });
      }

      try {
        await api.namePerson(keepId, { name: name.trim(), relationship: relationship?.trim() || undefined });
        if (twin) await api.mergePeople([keepId, twin._id === keepId ? personId : twin._id]);
      } catch (error) {
        if (isRejection(error)) {
          store.dispatch({ kind: 'revert-person', personId, person: before });
          notify(`Couldn't save that name. ${name.trim()} was put back the way it was.`);
          return;
        }
        notify(`Saved "${name.trim()}" on this phone. Amelia will sync it when the server is back.`, 'info');
      }
    },

    setAvatar: (personId, uri) => store.dispatch({ kind: 'set-avatar', personId, uri }),
    attributeUtterances: (utteranceIds, personId) =>
      store.dispatch({ kind: 'attribute-utterances', utteranceIds, personId }),
    /**
     * Closing a loop is a deliberate act, so it is written through rather than left in
     * memory. The guard registered by the optimistic dispatch is what stops the next
     * bus event or GET /promises — which still says 'open' — from un-closing it while
     * the round trip is in the air.
     */
    async setPromiseStatus(promiseId, status) {
      const before = store.getState().promises[promiseId];
      if (!before || before.status === status) return;
      store.dispatch({ kind: 'set-promise-status', promiseId, status });
      try {
        const updated = await api.setPromiseStatus(promiseId, status);
        store.dispatch({ kind: 'settle-promise-status', promiseId, promise: updated });
      } catch (error) {
        if (isRejection(error)) {
          store.dispatch({ kind: 'revert-promise-status', promiseId, status: before.status });
          notify(`Couldn't update "${before.text}". It is back the way it was.`);
          return;
        }
        // Unreachable, not refused. The owner's decision stands on this phone, and the
        // guard stays on so nothing inbound quietly reverses it.
        notify(status === 'done'
          ? `Marked "${before.text}" done on this phone. Amelia will sync it when the server is back.`
          : `Reopened "${before.text}" on this phone. Amelia will sync it when the server is back.`,
          'info');
      }
    },

    hydratePromises: (promises) => store.dispatch({ kind: 'hydrate-promises', promises }),

    /** Registers a due promise with the server so the reminder is not only local. */
    async scheduleReminder(promise) {
      if (!promise.due_at) return;
      try {
        await api.createReminder(promise._id, promise.due_at);
      } catch {
        // The local notification is already scheduled, so the owner still gets nudged.
        // Not worth a banner: nothing the owner can act on has been lost.
      }
    },

    renameConversation: (conversationId, title) =>
      store.dispatch({ kind: 'rename-conversation', conversationId, title }),

    /** Optimistic delete with a real undo: a refusal puts the transcript back. */
    async deleteConversation(conversationId) {
      const title = store.getState().conversations[conversationId]?.title ?? 'That conversation';
      store.dispatch({ kind: 'delete-conversation', conversationId });
      try {
        await api.deleteConversation(conversationId);
        store.dispatch({ kind: 'forget-deleted', conversationId });
      } catch {
        store.dispatch({ kind: 'undo-delete-conversation', conversationId });
        notify(`Couldn't delete "${title}". It is still here.`);
      }
    },

    dismissNameSuggestion: (voiceId, name) =>
      store.dispatch({ kind: 'dismiss-name-suggestion', voiceId, name }),
    dismissUnknownCard: () => store.dispatch({ kind: 'dismiss-unknown-card' }),
    recording: (event) => store.dispatch({ kind: 'recording', event }),
    setConnection: (source) => store.dispatch({ kind: 'set-connection', source }),
    notify,
    dismissNotice: (id) => store.dispatch({ kind: 'dismiss-notice', id }),
  };
}

export function AmeliaStoreProvider({
  children,
  initialState,
}: {
  children: ReactNode;
  initialState?: AmeliaState;
}) {
  const queueRef = useRef<{ events: AmeliaEvent[]; timer: ReturnType<typeof setTimeout> | null }>({
    events: [],
    timer: null,
  });
  const storeRef = useRef<StoreHandle | null>(null);
  if (!storeRef.current) storeRef.current = createStore(initialState ?? createInitialState());
  const store = storeRef.current;

  const actionsRef = useRef<Actions | null>(null);
  if (!actionsRef.current) actionsRef.current = createActions(store, queueRef.current);

  useEffect(() => {
    const queue = queueRef.current;
    return () => {
      if (queue.timer) clearTimeout(queue.timer);
      queue.timer = null;
    };
  }, []);

  /**
   * "Attributing…" has to be able to give up. The server can simply never come back
   * with a speaker, and a row that pulses forever reads as a hang rather than an
   * unknown. One sweep runs only while something is actually pending.
   */
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const sync = () => {
      const pending = Object.keys(store.getState().attributing).length > 0;
      if (pending && !timer) {
        timer = setInterval(() => store.dispatch({ kind: 'expire-attributions', now: Date.now() }), 2_000);
      } else if (!pending && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    sync();
    const unsubscribe = store.subscribe(sync);
    return () => {
      unsubscribe();
      if (timer) clearInterval(timer);
    };
  }, [store]);

  return (
    <StoreContext.Provider value={store}>
      <ActionsContext.Provider value={actionsRef.current}>{children}</ActionsContext.Provider>
    </StoreContext.Provider>
  );
}

export { ATTRIBUTION_TIMEOUT_MS };
