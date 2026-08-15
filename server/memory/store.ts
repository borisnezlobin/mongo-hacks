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

// People are created and renamed by Lane A, in server/identity/service.ts —
// that is where a person and their first voiceprint are written together, which
// is the only moment either makes sense on its own. `createUnnamedPerson` here
// had no callers and seeded `name: ''` where identity writes `'Unknown'`, so the
// two would have disagreed about what an unnamed person looks like the moment
// anything called it.

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

export interface DeletedConversation {
  utterances: number;
  facts: number;
  promises: number;
}

/**
 * Delete a conversation and everything derived from it.
 *
 * Facts and promises go too. They cite a source utterance, so leaving them
 * behind would leave memory asserting things it can no longer show you the
 * evidence for — which is worse than losing them. Callers are expected to say
 * so before asking.
 */
export async function deleteConversation(conversationId: Id): Promise<DeletedConversation> {
  const scope = { owner_id: OWNER_ID, conversation_id: conversationId };
  const utteranceIds = (await collections.utterances().find(scope).project({ _id: 1 }).toArray())
    .map((utterance) => utterance._id as Id);

  const source = { owner_id: OWNER_ID, primary_source_utterance_id: { $in: utteranceIds } };
  const facts = await collections.facts().deleteMany(source);
  const promises = await collections.promises().deleteMany({
    owner_id: OWNER_ID,
    source_utterance_id: { $in: utteranceIds },
  });
  const utterances = await collections.utterances().deleteMany(scope);
  await collections.conversations().deleteOne({ _id: conversationId, owner_id: OWNER_ID });

  return {
    utterances: utterances.deletedCount,
    facts: facts.deletedCount,
    promises: promises.deletedCount,
  };
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

// Merge lives in server/identity/service.ts. It keeps the oldest person and
// re-points every reference; voiceprints are never deleted, so a wrong merge
// stays recoverable because the vectors survive.
