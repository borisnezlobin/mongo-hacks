import type { Fact, Id, Person, PromiseMemory, Utterance } from '../../shared/contracts';
import { OWNER_ID } from '../../shared/contracts';
import { collections } from './db';

export interface ContextChangeRecord {
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

export interface ChangeGraphInput {
  previousFacts: Fact[];
  currentFacts: Fact[];
  utterances: Utterance[];
  people: Person[];
  promises: PromiseMemory[];
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

function relevantPromise(
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

/** Pure builder kept separate from Mongo access so temporal edge cases are auditable. */
export function buildContextChangeGraph(input: ChangeGraphInput): ContextChangeRecord[] {
  const currentById = new Map(input.currentFacts.map((fact) => [fact._id, fact]));
  const utteranceById = new Map(input.utterances.map((utterance) => [utterance._id, utterance]));
  const personById = new Map(input.people.map((person) => [person._id, person]));

  const recordedThrough = (source: Utterance | undefined): Id[] => {
    if (!source) return [];
    return [...new Set(input.utterances
      .filter((utterance) => (
        utterance.conversation_id === source.conversation_id
        && utterance.is_final
        && utterance.end_ms <= source.end_ms
        && utterance.person_id
      ))
      .map((utterance) => utterance.person_id as Id))];
  };

  const peopleNamed = (ids: Id[]) => ids
    .map((id) => personById.get(id))
    .filter((person): person is Person => Boolean(person))
    .map((person) => ({ id: person._id, name: person.name.trim() || 'Unknown speaker' }));

  return input.previousFacts.flatMap((before): ContextChangeRecord[] => {
    const after = before.superseded_by ? currentById.get(before.superseded_by) : undefined;
    if (!after) return [];
    const personName = personById.get(after.person_id)?.name.trim() || 'Unknown speaker';
    const oldSource = utteranceById.get(before.primary_source_utterance_id);
    const newSource = utteranceById.get(after.primary_source_utterance_id);
    const oldRecorded = recordedThrough(oldSource);
    const newRecorded = recordedThrough(newSource);
    const newRecordedSet = new Set(newRecorded);

    return [{
      id: after._id,
      person_id: after.person_id,
      person_name: personName,
      attribute: after.attribute,
      before: { _id: before._id, claim: before.claim },
      after: { _id: after._id, claim: after.claim, valid_from: after.valid_from },
      source_utterance_id: newSource?._id,
      conversation_id: newSource?.conversation_id,
      recorded_with: peopleNamed(newRecorded),
      may_have_missed: peopleNamed(oldRecorded.filter((id) => id !== after.person_id && !newRecordedSet.has(id))),
      affected_promises: input.promises
        .filter((promise) => relevantPromise(promise, after.person_id, personName, before.claim, after.claim))
        .slice(0, 3)
        .map(({ _id, text, due_at }) => ({ _id, text, due_at })),
    }];
  }).sort((a, b) => b.after.valid_from.localeCompare(a.after.valid_from));
}

/**
 * Reads the append-only supersession edges and just enough neighboring data to
 * explain their consequences. This is a read model only; no memory is rewritten.
 */
export async function listContextChanges(limit = 10): Promise<ContextChangeRecord[]> {
  const safeLimit = Math.max(1, Math.min(limit, 25));
  const previousFacts = await collections.facts()
    .find({
      owner_id: OWNER_ID,
      // A superseded fact points at its replacement. $type:'string' expresses that
      // directly; $ne:null does not typecheck because superseded_by is string|undefined.
      superseded_by: { $exists: true, $type: 'string' },
    })
    .sort({ superseded_at: -1, valid_from: -1 })
    .limit(safeLimit)
    .toArray();
  if (previousFacts.length === 0) return [];

  const currentIds = previousFacts.flatMap((fact) => fact.superseded_by ? [fact.superseded_by] : []);
  const currentFacts = await collections.facts()
    .find({ owner_id: OWNER_ID, _id: { $in: currentIds } })
    .toArray();
  const sourceIds = [...new Set([...previousFacts, ...currentFacts].map((fact) => fact.primary_source_utterance_id))];
  const sourceUtterances = await collections.utterances()
    .find({ owner_id: OWNER_ID, _id: { $in: sourceIds } })
    .toArray();
  const conversationIds = [...new Set(sourceUtterances.map((utterance) => utterance.conversation_id))];
  const utterances = await collections.utterances()
    .find({ owner_id: OWNER_ID, conversation_id: { $in: conversationIds } })
    .toArray();
  const people = await collections.people().find({ owner_id: OWNER_ID }).toArray();
  const promises = await collections.promises().find({ owner_id: OWNER_ID, status: 'open' }).toArray();

  return buildContextChangeGraph({ previousFacts, currentFacts, utterances, people, promises });
}
