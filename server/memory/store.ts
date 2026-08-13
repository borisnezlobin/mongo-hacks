import type { Filter } from 'mongodb';
import { OWNER_ID } from '../../shared/contracts';
import type {
  Conversation,
  Fact,
  Id,
  Person,
  PromiseMemory,
  Reminder,
  Utterance,
} from '../../shared/contracts';
import type { AmeliaBus } from '../lib/bus';
import { collections, insertIdempotent, nowIso } from './db';
import { embedDocuments } from './embeddings';
import { factAttributeAliases, normalizeClaim, normalizePromiseText } from './normalize';

const NOTE_ATTRIBUTE = 'note';

/**
 * A live fact is one nothing has replaced. Facts written here leave the field
 * absent; tolerating an explicit null keeps rows seeded by other lanes visible.
 */
const NOT_SUPERSEDED = { superseded_by: { $in: [null, undefined] } } as unknown as Filter<Fact>;

function id(prefix: string): Id {
  return `${prefix}-${crypto.randomUUID()}`;
}

export async function getPerson(personId: Id): Promise<Person | null> {
  return collections.people().findOne({ _id: personId, owner_id: OWNER_ID });
}

export async function listPeople(): Promise<Person[]> {
  return collections.people().find({ owner_id: OWNER_ID }).sort({ name: 1 }).toArray();
}

export async function createUnnamedPerson(): Promise<Person> {
  const timestamp = nowIso();
  const person: Person = {
    _id: id('person'),
    owner_id: OWNER_ID,
    name: '',
    created_at: timestamp,
    updated_at: timestamp,
  };
  await collections.people().insertOne(person);
  return person;
}

export async function namePerson(personId: Id, name: string, relationship?: string): Promise<Person | null> {
  const updated = await collections.people().findOneAndUpdate(
    { _id: personId, owner_id: OWNER_ID },
    { $set: { name, ...(relationship ? { relationship } : {}), updated_at: nowIso() } },
    { returnDocument: 'after' },
  );
  return updated ?? null;
}

/**
 * The current value of an attribute for a person. Supersession chains are
 * append-only, so "current" is the single row nothing has replaced yet.
 */
export async function resolveFactState(personId: Id, attribute: string): Promise<Fact | null> {
  return collections
    .facts()
    .findOne(
      { owner_id: OWNER_ID, person_id: personId, attribute: { $in: factAttributeAliases(attribute) }, ...NOT_SUPERSEDED },
      { sort: { valid_from: -1 } },
    );
}

export async function listCurrentFacts(personId?: Id): Promise<Fact[]> {
  return collections
    .facts()
    .find({
      owner_id: OWNER_ID,
      ...(personId ? { person_id: personId } : {}),
      ...NOT_SUPERSEDED,
    })
    .sort({ valid_from: -1 })
    .toArray();
}

export async function getFactHistory(personId: Id, attribute: string): Promise<Fact[]> {
  return collections
    .facts()
    .find({ owner_id: OWNER_ID, person_id: personId, attribute: { $in: factAttributeAliases(attribute) } })
    .sort({ valid_from: 1 })
    .toArray();
}

export interface FactDraft {
  person_id: Id;
  attribute: string;
  claim: string;
  primary_source_utterance_id: Id;
  valid_from?: string;
  /** Set when the slow pass adjudicated this claim as replacing an existing one. */
  supersedes?: Id;
}

/**
 * A fast pass and a later slow pass can extract the same sentence. Check the
 * idempotency identity before comparing it with current state, otherwise the
 * slow pass can mistake an already-recorded historical claim for a new change.
 */
export async function findFactBySourceClaim(sourceUtteranceId: Id, claim: string): Promise<Fact | null> {
  return collections.facts().findOne({
    owner_id: OWNER_ID,
    primary_source_utterance_id: sourceUtteranceId,
    claim_normalized: normalizeClaim(claim),
  });
}

export async function recordFact(bus: AmeliaBus, draft: FactDraft): Promise<Fact> {
  const timestamp = nowIso();
  const claimNormalized = normalizeClaim(draft.claim);
  const [embedding] = await embedDocuments([draft.claim]).catch(() => [undefined]);

  const fact: Fact = {
    _id: id('fact'),
    owner_id: OWNER_ID,
    person_id: draft.person_id,
    attribute: draft.attribute,
    claim: draft.claim,
    claim_normalized: claimNormalized,
    primary_source_utterance_id: draft.primary_source_utterance_id,
    ...(embedding ? { embedding } : {}),
    valid_from: draft.valid_from ?? timestamp,
    created_at: timestamp,
  };

  const { document, created } = await insertIdempotent(collections.facts(), fact, {
    owner_id: OWNER_ID,
    primary_source_utterance_id: draft.primary_source_utterance_id,
    claim_normalized: claimNormalized,
  });
  if (!created) return document;

  if (draft.supersedes) await supersedeFact(draft.supersedes, document._id, timestamp);
  bus.emit({
    type: 'fact',
    fact_id: document._id,
    person_id: document.person_id,
    attribute: document.attribute,
    claim: document.claim,
    ...(draft.supersedes ? { superseded_fact_id: draft.supersedes } : {}),
  });
  return document;
}

async function supersedeFact(oldFactId: Id, newFactId: Id, at: string): Promise<void> {
  await collections
    .facts()
    .updateOne({ _id: oldFactId, owner_id: OWNER_ID }, { $set: { superseded_by: newFactId, superseded_at: at } });
}

export async function addNote(bus: AmeliaBus, personId: Id, text: string): Promise<Fact> {
  return recordFact(bus, {
    person_id: personId,
    attribute: NOTE_ATTRIBUTE,
    claim: text,
    // Notes are volunteered by the owner rather than lifted from a turn; the
    // synthetic source id keeps the idempotency index meaningful.
    primary_source_utterance_id: `note-${normalizeClaim(text).slice(0, 60)}`,
  });
}

export interface PromiseDraft {
  person_id: Id;
  source_utterance_id: Id;
  text: string;
  due_at?: string;
  due_phrase?: string;
}

export async function recordPromise(bus: AmeliaBus, draft: PromiseDraft): Promise<PromiseMemory> {
  const timestamp = nowIso();
  const textNormalized = normalizePromiseText(draft.text);
  const promise: PromiseMemory = {
    _id: id('promise'),
    owner_id: OWNER_ID,
    person_id: draft.person_id,
    source_utterance_id: draft.source_utterance_id,
    text: draft.text,
    text_normalized: textNormalized,
    ...(draft.due_at ? { due_at: draft.due_at } : {}),
    ...(draft.due_phrase ? { due_phrase: draft.due_phrase } : {}),
    status: 'open',
    created_at: timestamp,
  };

  const { document, created } = await insertIdempotent(collections.promises(), promise, {
    owner_id: OWNER_ID,
    source_utterance_id: draft.source_utterance_id,
    text_normalized: textNormalized,
  });
  if (!created) return document;

  bus.emit({
    type: 'promise',
    promise_id: document._id,
    person_id: document.person_id,
    text: document.text,
    ...(document.due_at ? { due_at: document.due_at } : {}),
    status: document.status,
  });
  return document;
}

export async function listPromises(status?: PromiseMemory['status']): Promise<PromiseMemory[]> {
  return collections
    .promises()
    .find({ owner_id: OWNER_ID, ...(status ? { status } : {}) })
    .sort({ due_at: 1, created_at: 1 })
    .toArray();
}

export async function setPromiseStatus(
  promiseId: Id,
  status: PromiseMemory['status'],
  bus?: AmeliaBus,
): Promise<PromiseMemory | null> {
  const updated = await collections
    .promises()
    .findOneAndUpdate({ _id: promiseId, owner_id: OWNER_ID }, { $set: { status } }, { returnDocument: 'after' });
  if (updated && bus) {
    bus.emit({
      type: 'promise',
      promise_id: updated._id,
      person_id: updated.person_id,
      text: updated.text,
      ...(updated.due_at ? { due_at: updated.due_at } : {}),
      status: updated.status,
    });
  }
  return updated ?? null;
}

export async function createReminder(promiseId: Id, fireAt: string): Promise<Reminder> {
  const reminder: Reminder = {
    _id: id('reminder'),
    owner_id: OWNER_ID,
    promise_id: promiseId,
    fire_at: fireAt,
    status: 'scheduled',
    created_at: nowIso(),
  };
  await collections.reminders().insertOne(reminder);
  return reminder;
}

export async function getConversation(conversationId: Id): Promise<Conversation | null> {
  return collections.conversations().findOne({ _id: conversationId, owner_id: OWNER_ID });
}

export async function listConversations(): Promise<Conversation[]> {
  return collections.conversations().find({ owner_id: OWNER_ID }).sort({ started_at: -1 }).toArray();
}

export async function listUtterances(conversationId: Id): Promise<Utterance[]> {
  return collections
    .utterances()
    .find({ owner_id: OWNER_ID, conversation_id: conversationId })
    .sort({ start_ms: 1 })
    .toArray();
}

/** Utterances are written by whichever lane produced them; Lane B mirrors bus turns so extraction has a corpus. */
export async function upsertUtterance(utterance: Omit<Utterance, 'created_at' | 'updated_at'>): Promise<void> {
  const timestamp = nowIso();
  await collections.utterances().updateOne(
    { _id: utterance._id },
    { $set: { ...utterance, updated_at: timestamp }, $setOnInsert: { created_at: timestamp } },
    { upsert: true },
  );
}

/**
 * Merge keeps the oldest person and re-points every reference. Voiceprints are
 * never deleted — a wrong merge stays recoverable because the vectors survive.
 */
export async function mergePeople(bus: AmeliaBus, personIds: Id[]): Promise<Person> {
  const people = await collections
    .people()
    .find({ _id: { $in: personIds }, owner_id: OWNER_ID })
    .sort({ created_at: 1 })
    .toArray();
  if (people.length < 2) throw new Error('merge requires at least two existing people');

  const [survivor, ...absorbed] = people;
  const absorbedIds = absorbed.map((person) => person._id);
  const filter = { owner_id: OWNER_ID, person_id: { $in: absorbedIds } };

  const conversationIds = await collections.utterances().distinct('conversation_id', filter);
  await collections.voiceprints().updateMany(filter, { $set: { person_id: survivor._id } });
  await collections.utterances().updateMany(filter, { $set: { person_id: survivor._id } });
  await collections.facts().updateMany(filter, { $set: { person_id: survivor._id } });
  await collections.promises().updateMany(filter, { $set: { person_id: survivor._id } });

  const name = survivor.name || absorbed.find((person) => person.name)?.name || '';
  const merged = await collections.people().findOneAndUpdate(
    { _id: survivor._id },
    { $set: { name, updated_at: nowIso() } },
    { returnDocument: 'after' },
  );
  await collections.people().deleteMany({ _id: { $in: absorbedIds }, owner_id: OWNER_ID });

  for (const conversationId of conversationIds) {
    const utteranceIds = await collections
      .utterances()
      .distinct('_id', { owner_id: OWNER_ID, conversation_id: conversationId, person_id: survivor._id });
    bus.emit({
      type: 'identity',
      conversation_id: conversationId,
      person_id: survivor._id,
      name,
      utterance_ids: utteranceIds,
    });
  }
  return merged ?? survivor;
}
