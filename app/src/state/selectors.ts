import type { Conversation, Fact, Id, PromiseMemory, Utterance } from '../../../shared/contracts';
import { formatAgo } from '../lib/format';
import { liveConversationId } from './recording';
import type { PresenceRecord } from './presence';
import {
  displayName,
  isUnnamed,
  suggestionKey,
  type AmeliaState,
  type AmeliaTurn,
  type NameSuggestion,
  type PersonRecord,
} from './reducer';

/**
 * Every read of the store goes through one of these. They are plain functions of state
 * so they can be tested directly, and the hooks that wrap them compare results by value
 * — which is what keeps a transcript tick from re-rendering the People tab.
 */

export function shallowArrayEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

export function selectLiveConversationId(state: AmeliaState): Id | null {
  return liveConversationId(state.recording);
}

/** The raw person map, for callers that look voices up by key rather than list them. */
export function selectPeopleById(state: AmeliaState): Record<Id, PersonRecord> {
  return state.people;
}

export function selectSessionSpeakers(state: AmeliaState): Record<Id, Id> {
  return state.sessionSpeakerOf;
}

export function selectPeople(state: AmeliaState): PersonRecord[] {
  return Object.values(state.people).sort((a, b) => displayName(a).localeCompare(displayName(b)));
}

export function selectUnknownPeople(state: AmeliaState): PersonRecord[] {
  return Object.values(state.people).filter(isUnnamed);
}

export function selectOwner(state: AmeliaState): PersonRecord | undefined {
  return Object.values(state.people).find((person) => person.is_owner);
}

/**
 * Who the owner is, as tracked state. The old code compared against a seed constant,
 * so "You owe" was permanently empty against a real server.
 */
export function selectOwnerId(state: AmeliaState): Id | null {
  return selectOwner(state)?._id ?? null;
}

export function selectConversations(state: AmeliaState): Conversation[] {
  return Object.values(state.conversations).sort((a, b) => b.started_at.localeCompare(a.started_at));
}

/**
 * Conversations worth listing.
 *
 * A shell — a session that captured nothing — opens onto an empty screen, so it is
 * filtered out. But "has turns in memory" was the wrong test for that: it forced the app
 * to download every transcript on launch just to render a list of titles, which at
 * ~2,772 turns each is megabytes of JSON parsed on the main thread before Home paints.
 * A conversation the server listed is real whether or not its turns are loaded; only
 * locally-minted records have to prove themselves.
 */
export function selectListedConversations(state: AmeliaState): Conversation[] {
  const withTurns = new Set<Id>();
  for (const utterance of Object.values(state.utterances)) withTurns.add(utterance.conversation_id);
  return selectConversations(state).filter(
    (conversation) => state.serverConversations[conversation._id] || withTurns.has(conversation._id),
  );
}

export function selectConversationUtterances(state: AmeliaState, conversationId: Id | undefined): Utterance[] {
  if (!conversationId) return [];
  return Object.values(state.utterances)
    .filter((utterance) => utterance.conversation_id === conversationId)
    .sort((a, b) => a.start_ms - b.start_ms);
}

export function selectCurrentFacts(state: AmeliaState, personId: Id | undefined): Fact[] {
  if (!personId) return [];
  return Object.values(state.facts)
    .filter((fact) => fact.person_id === personId && !fact.superseded_by)
    .sort((a, b) => b.valid_from.localeCompare(a.valid_from));
}

export function selectSupersededFacts(state: AmeliaState, personId: Id | undefined): Fact[] {
  if (!personId) return [];
  return Object.values(state.facts)
    .filter((fact) => fact.person_id === personId && Boolean(fact.superseded_by))
    .sort((a, b) => b.valid_from.localeCompare(a.valid_from));
}

export function selectPromisesFor(state: AmeliaState, personId: Id | undefined): PromiseMemory[] {
  if (!personId) return [];
  return Object.values(state.promises).filter((promise) => promise.person_id === personId);
}

export function selectOpenPromiseCount(state: AmeliaState): number {
  let count = 0;
  for (const promise of Object.values(state.promises)) if (promise.status === 'open') count += 1;
  return count;
}

const byDue = (a: PromiseMemory, b: PromiseMemory) =>
  (a.due_at ?? '9999').localeCompare(b.due_at ?? '9999');

/** Promises the owner made are "you owe"; everyone else's are owed to the owner. */
export function selectOwedToYou(state: AmeliaState): PromiseMemory[] {
  const ownerId = selectOwnerId(state);
  return Object.values(state.promises)
    .filter((promise) => promise.status === 'open' && promise.person_id !== ownerId)
    .sort(byDue);
}

export function selectYouOwe(state: AmeliaState): PromiseMemory[] {
  const ownerId = selectOwnerId(state);
  if (!ownerId) return [];
  return Object.values(state.promises)
    .filter((promise) => promise.status === 'open' && promise.person_id === ownerId)
    .sort(byDue);
}

export function selectClosedPromises(state: AmeliaState): PromiseMemory[] {
  return Object.values(state.promises).filter((promise) => promise.status !== 'open');
}

/** The turn whose trace the pill is showing: the newest one. */
export function selectLatestAmeliaTurn(state: AmeliaState): AmeliaTurn | null {
  const id = state.ameliaOrder[state.ameliaOrder.length - 1];
  return id ? state.ameliaTurns[id] ?? null : null;
}

/**
 * Every Amelia turn belonging to a transcript, oldest first. A second answer no longer
 * erases the first mid-read; both stay in the conversation where they were spoken.
 */
export function selectAmeliaTurnsFor(state: AmeliaState, conversationId: Id | undefined): AmeliaTurn[] {
  if (!conversationId) return [];
  return state.ameliaOrder
    .map((id) => state.ameliaTurns[id])
    .filter((turn): turn is AmeliaTurn => Boolean(turn)
      && (!turn.conversation_id || turn.conversation_id === conversationId));
}

/**
 * The name proposed for a voice, if there is one worth asking about.
 *
 * A voice the owner has already named is never asked about, even if the suggestion was
 * parked before the name landed, and neither is one whose suggestion was turned down.
 */
export function selectNameSuggestionFor(state: AmeliaState, voiceId: Id | undefined): NameSuggestion | undefined {
  if (!voiceId) return undefined;
  const suggestion = state.nameSuggestions[voiceId];
  if (!suggestion) return undefined;
  const person = state.people[voiceId];
  if (person && !isUnnamed(person) && !person.provisional) return undefined;
  if (state.dismissedSuggestions[suggestionKey(voiceId, suggestion.name)]) return undefined;
  return suggestion;
}

export function selectCurrentClaimsByPerson(state: AmeliaState): Record<Id, string[]> {
  const map: Record<Id, string[]> = {};
  for (const fact of Object.values(state.facts)) {
    if (fact.superseded_by) continue;
    (map[fact.person_id] ??= []).push(fact.claim);
  }
  return map;
}

export interface PresentPerson {
  presence: PresenceRecord;
  person?: PersonRecord;
}

/**
 * Who is in the room, speakers first.
 *
 * Expiry is applied here as well as by the sweep, so a card cannot outlive its
 * window just because the interval has not fired yet.
 */
export function selectPresentPeople(state: AmeliaState, now: number): PresentPerson[] {
  return Object.values(state.presence)
    .filter((record) => record.expires_at > now)
    .sort((a, b) => Number(b.speaking) - Number(a.speaking) || b.expires_at - a.expires_at)
    .map((record) => ({ presence: record, person: state.people[record.person_id] }));
}

export type LastSeenKind = 'talked' | 'seen' | 'first';

export interface LastSeenLine {
  kind: LastSeenKind;
  text: string;
}

const GENERATED_TITLE = /^conversation,/i;

function lastConversationWith(state: AmeliaState, personId: Id): Conversation | undefined {
  return Object.values(state.conversations)
    .filter((conversation) => conversation.participant_ids.includes(personId))
    .sort((a, b) => (b.ended_at ?? b.started_at).localeCompare(a.ended_at ?? a.started_at))[0];
}

/**
 * The one line on a presence card.
 *
 * Three states rather than one blank-when-unknown, because "we have never met"
 * and "we talked last month" are the two most useful things to know about
 * someone standing in front of you, and an empty caption says neither. A
 * conversation the owner or the model actually titled is worth naming; a
 * generated "Conversation, 4:15 pm" is not.
 */
export function selectLastSeenLine(state: AmeliaState, personId: Id | undefined, now: number): LastSeenLine {
  const person = personId ? state.people[personId] : undefined;
  const conversation = personId ? lastConversationWith(state, personId) : undefined;
  if (conversation) {
    const when = formatAgo(conversation.ended_at ?? conversation.started_at, now);
    const title = conversation.title && !GENERATED_TITLE.test(conversation.title) ? conversation.title : undefined;
    return { kind: 'talked', text: title ? `Last talked ${when}, about ${title}` : `Last talked ${when}` };
  }
  if (person?.last_seen_at) return { kind: 'seen', text: `Saw them ${formatAgo(person.last_seen_at, now)}` };
  return { kind: 'first', text: 'First time meeting' };
}
