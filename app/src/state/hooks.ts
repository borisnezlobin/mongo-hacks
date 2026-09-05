import { useCallback } from 'react';
import type { Conversation, Fact, Id, PromiseMemory, Utterance } from '../../../shared/contracts';
import {
  ATTRIBUTION_TIMEOUT_MS,
  type AmeliaState,
  type AmeliaTurn,
  type NameSuggestion,
  type Notice,
  type PersonRecord,
} from './reducer';
import type { RecordingState } from './recording';
import type { GlassesState } from './glasses';
import {
  selectAmeliaTurnsFor,
  selectClosedPromises,
  selectConversationUtterances,
  selectConversations,
  selectCurrentClaimsByPerson,
  selectCurrentFacts,
  selectLatestAmeliaTurn,
  selectListedConversations,
  selectNameSuggestionFor,
  selectLiveConversationId,
  selectOpenPromiseCount,
  selectOwedToYou,
  selectOwnerId,
  selectLastSeenLine,
  selectPeople,
  selectPresentPeople,
  selectPromisesFor,
  selectSupersededFacts,
  selectUnknownPeople,
  selectYouOwe,
  shallowArrayEqual,
  type LastSeenLine,
  type PresentPerson,
} from './selectors';
import { useSelector } from './store';

/**
 * One hook per thing a screen reads. Nothing outside this file pulls the whole state
 * object, which is what makes the re-render boundaries real rather than aspirational.
 */

const selectRecording = (state: AmeliaState) => state.recording;
const selectConnection = (state: AmeliaState) => state.connection;
const selectNotices = (state: AmeliaState) => state.notices;
const selectGlasses = (state: AmeliaState) => state.glasses;

export function useRecordingState(): RecordingState {
  return useSelector(selectRecording);
}

export function useLiveConversationId(): Id | null {
  return useSelector(selectLiveConversationId);
}

export function usePeople(): PersonRecord[] {
  return useSelector(selectPeople, shallowArrayEqual);
}

export function useUnknownPeople(): PersonRecord[] {
  return useSelector(selectUnknownPeople, shallowArrayEqual);
}

export function usePerson(personId: Id | undefined): PersonRecord | undefined {
  return useSelector(useCallback((state: AmeliaState) => (personId ? state.people[personId] : undefined), [personId]));
}

export function useOwnerId(): Id | null {
  return useSelector(selectOwnerId);
}

export function useAvatarUri(personId: Id | undefined): string | undefined {
  return useSelector(useCallback((state: AmeliaState) => (personId ? state.avatars[personId] : undefined), [personId]));
}

export function useConversations(): Conversation[] {
  return useSelector(selectConversations, shallowArrayEqual);
}

export function useListedConversations(): Conversation[] {
  return useSelector(selectListedConversations, shallowArrayEqual);
}

export function useConversation(conversationId: Id | undefined): Conversation | undefined {
  return useSelector(useCallback(
    (state: AmeliaState) => (conversationId ? state.conversations[conversationId] : undefined),
    [conversationId],
  ));
}

export function useConversationUtterances(conversationId: Id | undefined): Utterance[] {
  return useSelector(
    useCallback((state: AmeliaState) => selectConversationUtterances(state, conversationId), [conversationId]),
    shallowArrayEqual,
  );
}

export function useCurrentFacts(personId: Id | undefined): Fact[] {
  return useSelector(
    useCallback((state: AmeliaState) => selectCurrentFacts(state, personId), [personId]),
    shallowArrayEqual,
  );
}

export function useSupersededFacts(personId: Id | undefined): Fact[] {
  return useSelector(
    useCallback((state: AmeliaState) => selectSupersededFacts(state, personId), [personId]),
    shallowArrayEqual,
  );
}

export function usePromisesFor(personId: Id | undefined): PromiseMemory[] {
  return useSelector(
    useCallback((state: AmeliaState) => selectPromisesFor(state, personId), [personId]),
    shallowArrayEqual,
  );
}

export function useOpenPromiseCount(): number {
  return useSelector(selectOpenPromiseCount);
}

export function useOwedToYou(): PromiseMemory[] {
  return useSelector(selectOwedToYou, shallowArrayEqual);
}

export function useYouOwe(): PromiseMemory[] {
  return useSelector(selectYouOwe, shallowArrayEqual);
}

export function useClosedPromises(): PromiseMemory[] {
  return useSelector(selectClosedPromises, shallowArrayEqual);
}

export function usePromise(promiseId: Id | undefined): PromiseMemory | undefined {
  return useSelector(useCallback(
    (state: AmeliaState) => (promiseId ? state.promises[promiseId] : undefined),
    [promiseId],
  ));
}

export function useUtterance(utteranceId: Id | undefined): Utterance | undefined {
  return useSelector(useCallback(
    (state: AmeliaState) => (utteranceId ? state.utterances[utteranceId] : undefined),
    [utteranceId],
  ));
}

export function useLatestAmeliaTurn(): AmeliaTurn | null {
  return useSelector(selectLatestAmeliaTurn);
}

export function useAmeliaTurnsFor(conversationId: Id | undefined): AmeliaTurn[] {
  return useSelector(
    useCallback((state: AmeliaState) => selectAmeliaTurnsFor(state, conversationId), [conversationId]),
    shallowArrayEqual,
  );
}

export function useClaimsByPerson(): Record<Id, string[]> {
  return useSelector(selectCurrentClaimsByPerson, (a, b) => {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) => shallowArrayEqual(a[key], b[key] ?? []));
  });
}

/**
 * Whether the server is still working out who said this.
 *
 * Only 'gathering' counts. 'no_match' and 'ambiguous' mean it listened and could not
 * tell, and "Attributing…" would promise an answer that is not coming.
 */
export function useIsAttributing(utteranceId: Id): boolean {
  return useSelector(useCallback((state: AmeliaState) => {
    const waiting = state.attributing[utteranceId];
    return waiting !== undefined
      && waiting.reason === 'gathering'
      && Date.now() - waiting.since < ATTRIBUTION_TIMEOUT_MS;
  }, [utteranceId]));
}

/** The diarization cluster credited with a turn, for voices with no person record yet. */
export function useSessionSpeaker(utteranceId: Id | undefined): Id | undefined {
  return useSelector(useCallback(
    (state: AmeliaState) => (utteranceId ? state.sessionSpeakerOf[utteranceId] : undefined),
    [utteranceId],
  ));
}

/** A name overheard for this voice, or nothing if it is named or was turned down. */
export function useNameSuggestion(voiceId: Id | undefined): NameSuggestion | undefined {
  return useSelector(useCallback(
    (state: AmeliaState) => selectNameSuggestionFor(state, voiceId),
    [voiceId],
  ));
}

export function useConnection() {
  return useSelector(selectConnection);
}

export function useNotices(): Notice[] {
  return useSelector(selectNotices, shallowArrayEqual);
}

/**
 * Who is in the room. Read with a clock rather than a timestamp so a card
 * disappears on the sweep, not on the next unrelated store change.
 */
export function usePresentPeople(): PresentPerson[] {
  return useSelector(
    useCallback((state: AmeliaState) => selectPresentPeople(state, Date.now()), []),
    (a, b) => shallowArrayEqual(a.map((entry) => entry.presence), b.map((entry) => entry.presence))
      && shallowArrayEqual(a.map((entry) => entry.person), b.map((entry) => entry.person)),
  );
}

export function useLastSeenLine(personId: Id | undefined): LastSeenLine {
  return useSelector(
    useCallback((state: AmeliaState) => selectLastSeenLine(state, personId, Date.now()), [personId]),
    (a, b) => a.kind === b.kind && a.text === b.text,
  );
}

export function useGlassesState(): GlassesState {
  return useSelector(selectGlasses);
}
