import type { Fact, Id, PromiseMemory } from '../../../shared/contracts';
import type { AmeliaState } from './store';
import { displayName } from './store';

export interface ContextChange {
  id: Id;
  person_id: Id;
  person_name: string;
  attribute: string;
  before: Pick<Fact, '_id' | 'claim'>;
  after: Pick<Fact, '_id' | 'claim' | 'valid_from'>;
  source_utterance_id?: Id;
  conversation_id?: Id;
  recorded_with: { id: Id; name: string }[];
  may_have_missed: { id: Id; name: string }[];
  affected_promises: Pick<PromiseMemory, '_id' | 'text' | 'due_at'>[];
}

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'before', 'from', 'into', 'moving', 'that', 'their',
  'there', 'they', 'this', 'with', 'your', 'september',
]);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((word) => word.length >= 4 && !STOP_WORDS.has(word));
}

function promiseTouchesChange(
  promise: PromiseMemory,
  personId: Id,
  personName: string,
  before: string,
  after: string,
): boolean {
  if (promise.status !== 'open') return false;
  if (promise.person_id === personId) return true;
  const normalized = promise.text.toLowerCase();
  if (personName && normalized.includes(personName.toLowerCase())) return true;
  const changeWords = new Set([...words(before), ...words(after)]);
  return words(promise.text).some((word) => changeWords.has(word));
}

function participantsThroughSource(state: AmeliaState, sourceId: Id | undefined): Id[] {
  if (!sourceId) return [];
  const source = state.utterances[sourceId];
  if (!source) return [];
  return [...new Set(Object.values(state.utterances)
    .filter((utterance) => (
      utterance.conversation_id === source.conversation_id
      && utterance.is_final
      && utterance.end_ms <= source.end_ms
      && utterance.person_id
    ))
    .map((utterance) => utterance.person_id as Id))];
}

function namedPeople(state: AmeliaState, ids: Id[]): { id: Id; name: string }[] {
  return ids
    .map((id) => state.people[id])
    .filter(Boolean)
    .map((person) => ({ id: person._id, name: displayName(person) }));
}

/**
 * Turns the append-only supersession graph into Amelia's primary product object:
 * a before/after change with provenance, possible downstream work, and recorded
 * context gaps. "May have missed" is deliberately an inference from recordings,
 * never a claim about what another person knows.
 */
export function deriveContextChanges(state: AmeliaState): ContextChange[] {
  const facts = Object.values(state.facts);
  const promises = Object.values(state.promises);

  return facts
    .filter((before) => Boolean(before.superseded_by && state.facts[before.superseded_by]))
    .map((before): ContextChange => {
      const after = state.facts[before.superseded_by!]!;
      const person = state.people[after.person_id];
      const personName = displayName(person);
      const oldRecorded = participantsThroughSource(state, before.primary_source_utterance_id);
      const newRecorded = participantsThroughSource(state, after.primary_source_utterance_id);
      const newRecordedSet = new Set(newRecorded);
      const mayHaveMissed = oldRecorded.filter((id) => id !== after.person_id && !newRecordedSet.has(id));
      const source = state.utterances[after.primary_source_utterance_id];

      return {
        id: after._id,
        person_id: after.person_id,
        person_name: personName,
        attribute: after.attribute,
        before: { _id: before._id, claim: before.claim },
        after: { _id: after._id, claim: after.claim, valid_from: after.valid_from },
        source_utterance_id: source?._id,
        conversation_id: source?.conversation_id,
        recorded_with: namedPeople(state, newRecorded),
        may_have_missed: namedPeople(state, mayHaveMissed),
        affected_promises: promises
          .filter((promise) => promiseTouchesChange(promise, after.person_id, personName, before.claim, after.claim))
          .slice(0, 3)
          .map(({ _id, text, due_at }) => ({ _id, text, due_at })),
      };
    })
    .sort((a, b) => b.after.valid_from.localeCompare(a.after.valid_from));
}

export function humanizeAttribute(attribute: string): string {
  return attribute.replace(/_/g, ' ');
}
