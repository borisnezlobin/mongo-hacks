import { OWNER_ID } from '../../shared/contracts';
import type {
  Conversation,
  Fact,
  Id,
  Person,
  PromiseMemory,
  Reminder,
  Timestamp,
  Utterance,
} from '../../shared/contracts';
import type { AmeliaBus } from '../lib/bus';
import { getStorage, rankByCosine, type Filter } from '../storage';
import { collections, insertIdempotent, nowIso } from './db';
import { embedDocuments } from './embeddings';
import { factAttributeAliases, normalizeClaim, normalizePromiseText } from './normalize';

const NOTE_ATTRIBUTE = 'note';

/**
 * A live fact is one nothing has replaced. Facts written here leave the field
 * absent; tolerating an explicit null keeps rows seeded by other lanes visible.
 */
const NOT_SUPERSEDED: Filter = { superseded_by: { $in: [null, undefined] } };

/**
 * `Fact` is frozen, but the row needs somewhere to record that its embedding
 * never landed. These fields exist only on disk, never on the wire.
 */
type StoredFact = Fact & { embedding_pending_since?: Timestamp; embedding_error?: string };

function id(prefix: string): Id {
  return `${prefix}-${crypto.randomUUID()}`;
}

export async function getPerson(personId: Id): Promise<Person | null> {
  return collections.people().findOne({ _id: personId, owner_id: OWNER_ID });
}

export async function listPeople(): Promise<Person[]> {
  return collections.people().find({ owner_id: OWNER_ID }).sort({ name: 1 }).toArray();
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

/**
 * Losing the embedding is bad; losing the fact is worse. The claim is still
 * findable lexically without a vector, so a failed embedding stores the fact,
 * says so, and marks the row for `backfillFactEmbeddings` — it must never be a
 * swallowed exception that leaves memory permanently unsearchable in silence.
 */
async function embedClaim(claim: string): Promise<{ embedding?: number[]; error?: string }> {
  try {
    const [embedding] = await embedDocuments([claim]);
    if (!embedding) return { error: 'embedding provider returned no vector' };
    return { embedding };
  } catch (error) {
    const message = (error as Error).message;
    console.error(`[memory] embedding failed for a fact; stored without one and queued for backfill: ${message}`);
    return { error: message };
  }
}

export async function recordFact(bus: AmeliaBus, draft: FactDraft): Promise<Fact> {
  const timestamp = nowIso();
  const claimNormalized = normalizeClaim(draft.claim);
  const { embedding, error } = await embedClaim(draft.claim);

  const fact: StoredFact = {
    _id: id('fact'),
    owner_id: OWNER_ID,
    person_id: draft.person_id,
    attribute: draft.attribute,
    claim: draft.claim,
    claim_normalized: claimNormalized,
    primary_source_utterance_id: draft.primary_source_utterance_id,
    ...(embedding ? { embedding } : { embedding_pending_since: timestamp, embedding_error: error }),
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

export interface EmbeddingBackfill {
  pending: number;
  embedded: number;
  failed: number;
}

/**
 * Re-embeds facts written while the embedding provider was down. Safe to run
 * repeatedly; a fact that already has a vector is never touched.
 */
export async function backfillFactEmbeddings(batchSize = 32): Promise<EmbeddingBackfill> {
  const pending = await collections
    .facts()
    .find({ owner_id: OWNER_ID, embedding: { $exists: false } })
    .toArray();
  let embedded = 0;
  let failed = 0;

  for (let offset = 0; offset < pending.length; offset += batchSize) {
    const batch = pending.slice(offset, offset + batchSize);
    let vectors: number[][];
    try {
      vectors = await embedDocuments(batch.map((fact) => fact.claim));
    } catch (error) {
      console.error(`[memory] embedding backfill batch failed: ${(error as Error).message}`);
      failed += batch.length;
      continue;
    }
    for (const [index, fact] of batch.entries()) {
      const embedding = vectors[index];
      if (!embedding) {
        failed += 1;
        continue;
      }
      await collections.facts().updateOne(
        { _id: fact._id },
        { $set: { embedding }, $unset: { embedding_pending_since: '', embedding_error: '' } },
      );
      embedded += 1;
    }
  }
  return { pending: pending.length, embedded, failed };
}

export interface ScoredFact {
  fact: Fact;
  /** Raw cosine in [-1, 1]. */
  score: number;
}

/**
 * Semantic fact search without Atlas Vector Search.
 *
 * At this corpus size an exact cosine scan over the live facts is both faster
 * than a round trip to an approximate index and, unlike `$vectorSearch`, works
 * identically on either backend and needs no index build. This is the
 * replacement `server/ask/retrieval.ts` should call instead of `$vectorSearch`.
 */
export async function searchFactsByEmbedding(embedding: number[], personId?: Id, limit = 10): Promise<ScoredFact[]> {
  const live = await collections
    .facts()
    .find({ owner_id: OWNER_ID, ...(personId ? { person_id: personId } : {}), ...NOT_SUPERSEDED })
    .toArray();
  return rankByCosine(live, (fact) => fact.embedding, embedding, limit).map(({ document, cosine }) => ({
    fact: document,
    score: cosine,
  }));
}

/**
 * The lexical half of retrieval, in process. Scores live facts by how many of
 * the query's terms appear in the claim or attribute, so `/ask` keeps working
 * when the Atlas Search index is absent.
 */
export async function searchFactsByKeyword(query: string, personId?: Id, limit = 10): Promise<ScoredFact[]> {
  const terms = [...new Set(normalizeClaim(query).split(/\s+/).filter((term) => term.length > 2))];
  if (terms.length === 0) return [];

  const live = await collections
    .facts()
    .find({ owner_id: OWNER_ID, ...(personId ? { person_id: personId } : {}), ...NOT_SUPERSEDED })
    .toArray();

  return live
    .map((fact) => {
      const haystack = `${fact.claim} ${fact.attribute}`.toLowerCase();
      const hits = terms.filter((term) => haystack.includes(term)).length;
      return { fact, score: hits / terms.length };
    })
    .filter((scored) => scored.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
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

export async function listReminders(status?: Reminder['status']): Promise<Reminder[]> {
  return collections
    .reminders()
    .find({ owner_id: OWNER_ID, ...(status ? { status } : {}) })
    .sort({ fire_at: 1 })
    .toArray();
}

/**
 * Reminders were written and never read back, so nothing could ever fire one.
 * This is the read side; a scheduler polls it and calls `markReminderSent`.
 */
export async function listDueReminders(asOf: Timestamp = nowIso()): Promise<Reminder[]> {
  return collections
    .reminders()
    .find({ owner_id: OWNER_ID, status: 'scheduled', fire_at: { $lte: asOf } })
    .sort({ fire_at: 1 })
    .toArray();
}

export async function markReminderSent(reminderId: Id): Promise<Reminder | null> {
  const updated = await collections
    .reminders()
    .findOneAndUpdate({ _id: reminderId, owner_id: OWNER_ID }, { $set: { status: 'sent' } }, { returnDocument: 'after' });
  return updated ?? null;
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
  reminders: number;
}

/**
 * Delete a conversation and everything derived from it.
 *
 * Facts and promises go too. They cite a source utterance, so leaving them
 * behind would leave memory asserting things it can no longer show you the
 * evidence for — which is worse than losing them. Callers are expected to say
 * so before asking.
 *
 * Everything happens in one transaction, and the references *into* the deleted
 * rows are repaired rather than left dangling: a surviving fact whose
 * `superseded_by` pointed at a deleted fact becomes live again (it is, once more,
 * the thing nothing has replaced), and reminders for deleted promises go with
 * them.
 */
export async function deleteConversation(conversationId: Id): Promise<DeletedConversation> {
  const storage = await getStorage();
  return storage.transact(async (collection) => {
    const scope = { owner_id: OWNER_ID, conversation_id: conversationId };
    const utteranceIds = (await collection<Utterance>('utterances').find(scope).project({ _id: 1 }).toArray()).map(
      (utterance) => utterance._id as Id,
    );

    const source = { owner_id: OWNER_ID, primary_source_utterance_id: { $in: utteranceIds } };
    const doomedFactIds = (await collection<Fact>('facts').find(source).project({ _id: 1 }).toArray()).map(
      (fact) => fact._id as Id,
    );
    const doomedPromiseIds = (
      await collection<PromiseMemory>('promises')
        .find({ owner_id: OWNER_ID, source_utterance_id: { $in: utteranceIds } })
        .project({ _id: 1 })
        .toArray()
    ).map((promise) => promise._id as Id);

    const facts = await collection<Fact>('facts').deleteMany(source);
    await collection<Fact>('facts').updateMany(
      { owner_id: OWNER_ID, superseded_by: { $in: doomedFactIds } },
      { $unset: { superseded_by: '', superseded_at: '' } },
    );

    const promises = await collection<PromiseMemory>('promises').deleteMany({
      owner_id: OWNER_ID,
      source_utterance_id: { $in: utteranceIds },
    });
    const reminders = await collection<Reminder>('reminders').deleteMany({
      owner_id: OWNER_ID,
      promise_id: { $in: doomedPromiseIds },
    });

    const utterances = await collection<Utterance>('utterances').deleteMany(scope);
    await collection<Conversation>('conversations').deleteOne({ _id: conversationId, owner_id: OWNER_ID });

    return {
      utterances: utterances.deletedCount,
      facts: facts.deletedCount,
      promises: promises.deletedCount,
      reminders: reminders.deletedCount,
    };
  });
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
  if (utterance.person_id) {
    await recordParticipant(utterance.conversation_id, utterance.person_id, timestamp);
  }
}

/**
 * `Conversation.participant_ids` used to be written once as `[]` and never
 * touched again, so every reader either ignored it or recomputed the answer from
 * utterances. Attribution is what makes someone a participant, so this maintains
 * the field at the same moment the utterance learns whose it is.
 */
async function recordParticipant(conversationId: Id, personId: Id, timestamp: string): Promise<void> {
  const conversation = await collections.conversations().findOne({ _id: conversationId });
  if (!conversation) {
    await collections.conversations().updateOne(
      { _id: conversationId },
      {
        $set: { participant_ids: [personId] },
        $setOnInsert: { owner_id: OWNER_ID, started_at: timestamp },
      },
      { upsert: true },
    );
    return;
  }
  const participants = conversation.participant_ids ?? [];
  if (participants.includes(personId)) return;
  await collections
    .conversations()
    .updateOne({ _id: conversationId }, { $set: { participant_ids: [...participants, personId] } });
}

/**
 * Merge keeps the oldest person and re-points every reference. Voiceprints are
 * never deleted — a wrong merge stays recoverable because the vectors survive.
 *
 * All six re-pointing writes plus the participant rewrite happen in one
 * transaction. Previously a failure part-way through left utterances, facts or
 * promises pointing at a `person_id` that no longer existed, with no way back.
 */
export async function mergePeople(bus: AmeliaBus, personIds: Id[]): Promise<Person> {
  const storage = await getStorage();
  const { survivor, name, conversationIds } = await storage.transact(async (collection) => {
    const people = await collection<Person>('people')
      .find({ _id: { $in: personIds }, owner_id: OWNER_ID })
      .sort({ created_at: 1 })
      .toArray();
    if (people.length < 2) throw new Error('merge requires at least two existing people');

    const [oldest, ...absorbed] = people;
    const absorbedIds = absorbed.map((person) => person._id);
    const filter = { owner_id: OWNER_ID, person_id: { $in: absorbedIds } };

    const conversationIds = (await collection<Utterance>('utterances').distinct('conversation_id', filter)) as Id[];
    const repoint = { $set: { person_id: oldest._id } };
    await collection<never>('voiceprints').updateMany(filter, repoint);
    await collection<never>('utterances').updateMany(filter, repoint);
    await collection<never>('facts').updateMany(filter, repoint);
    await collection<never>('promises').updateMany(filter, repoint);

    // participant_ids is a list, not a person_id column, so updateMany cannot
    // re-point it; each affected conversation is rewritten explicitly.
    const conversations = await collection<Conversation>('conversations')
      .find({ owner_id: OWNER_ID, participant_ids: { $in: absorbedIds } })
      .toArray();
    for (const conversation of conversations) {
      const participants = [
        ...new Set(conversation.participant_ids.map((id) => (absorbedIds.includes(id) ? oldest._id : id))),
      ];
      await collection<Conversation>('conversations').updateOne(
        { _id: conversation._id },
        { $set: { participant_ids: participants } },
      );
    }

    const name = oldest.name || absorbed.find((person) => person.name)?.name || '';
    const merged = await collection<Person>('people').findOneAndUpdate(
      { _id: oldest._id },
      { $set: { name, updated_at: nowIso() } },
      { returnDocument: 'after' },
    );
    await collection<Person>('people').deleteMany({ _id: { $in: absorbedIds }, owner_id: OWNER_ID });

    return { survivor: merged ?? oldest, name, conversationIds };
  });

  for (const conversationId of conversationIds) {
    const utteranceIds = (await collections
      .utterances()
      .distinct('_id', { owner_id: OWNER_ID, conversation_id: conversationId, person_id: survivor._id })) as Id[];
    bus.emit({
      type: 'identity',
      conversation_id: conversationId,
      person_id: survivor._id,
      name,
      utterance_ids: utteranceIds,
      confidence: 'confirmed',
    });
  }
  return survivor;
}
