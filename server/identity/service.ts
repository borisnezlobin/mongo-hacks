import type {
  EnrollVoiceRequest,
  EnrollVoiceResponse,
  Fact,
  MergePeopleRequest,
  NamePersonRequest,
  Person,
  PromiseMemory,
  ServerDependencies,
  Utterance,
  Voiceprint,
} from '../../shared/contracts';
import {
  ATTRIBUTION_THRESHOLD,
  EMBED_MIN_MS,
  OWNER_AUTH_THRESHOLD,
  OWNER_ID,
  VOICEPRINT_DIMS,
} from '../../shared/contracts';

type Filter = Record<string, unknown>;
type Update<T> = { $set: Partial<T> };

export interface IdentityCollection<T> {
  insertOne(document: T): Promise<unknown>;
  find(filter?: Filter): { toArray(): Promise<T[]> };
  findOne(filter: Filter): Promise<T | null>;
  updateOne(filter: Filter, update: Update<T>): Promise<unknown>;
  updateMany(filter: Filter, update: Update<T>): Promise<unknown>;
  deleteMany(filter: Filter): Promise<unknown>;
  distinct(key: string, filter: Filter): Promise<unknown[]>;
}

export interface IdentityServiceOptions {
  collections: {
    people: IdentityCollection<Person>;
    voiceprints: IdentityCollection<Voiceprint>;
    utterances: IdentityCollection<Utterance>;
    facts: IdentityCollection<Fact>;
    promises: IdentityCollection<PromiseMemory>;
  };
  bus: ServerDependencies['bus'];
  now?: () => Date;
}

export interface IdentityService {
  attributeSpeaker(input: {
    embedding: number[];
    duration_ms: number;
    conversation_id: string;
    utterance_ids: string[];
  }): Promise<
    | { status: 'pending'; reason: 'below_floor' }
    | { status: 'matched'; person_id: string; voiceprint_id: string; confidence: number }
    | { status: 'created'; person_id: string; voiceprint_id: string }
  >;
  isOwnerVoice(embedding: number[]): Promise<{ authorized: boolean; confidence: number }>;
  enroll(request: EnrollVoiceRequest): Promise<EnrollVoiceResponse>;
  namePerson(personId: string, request: NamePersonRequest): Promise<Person>;
  mergePeople(request: MergePeopleRequest): Promise<Person>;
}

function dotProduct(left: number[], right: number[]): number {
  return left.reduce((score, component, index) => score + component * (right[index] ?? 0), 0);
}

export function createIdentityService(_options: IdentityServiceOptions): IdentityService {
  const { collections, bus } = _options;
  const timestamp = () => (_options.now?.() ?? new Date()).toISOString();

  return {
    async attributeSpeaker(input) {
      if (input.duration_ms < EMBED_MIN_MS) {
        return { status: 'pending', reason: 'below_floor' };
      }

      const voiceprints = await collections.voiceprints.find({ owner_id: OWNER_ID }).toArray();
      let best: { voiceprint: Voiceprint; confidence: number } | undefined;
      for (const voiceprint of voiceprints) {
        const confidence = dotProduct(voiceprint.embedding, input.embedding);
        if (!best || confidence > best.confidence) best = { voiceprint, confidence };
      }

      if (best && best.confidence >= ATTRIBUTION_THRESHOLD) {
        const person = await collections.people.findOne({
          _id: best.voiceprint.person_id,
          owner_id: OWNER_ID,
        });
        if (!person) throw new Error(`Unknown person: ${best.voiceprint.person_id}`);
        await collections.utterances.updateMany(
          { _id: { $in: input.utterance_ids }, owner_id: OWNER_ID },
          {
            $set: {
              person_id: person._id,
              voiceprint_id: best.voiceprint._id,
              updated_at: timestamp(),
            },
          },
        );
        bus.emit({
          type: 'identity',
          conversation_id: input.conversation_id,
          person_id: person._id,
          voiceprint_id: best.voiceprint._id,
          name: person.name,
          utterance_ids: input.utterance_ids,
        });
        return {
          status: 'matched',
          person_id: person._id,
          voiceprint_id: best.voiceprint._id,
          confidence: best.confidence,
        };
      }

      const now = timestamp();
      const person: Person = {
        _id: crypto.randomUUID(),
        owner_id: OWNER_ID,
        name: 'Unknown',
        created_at: now,
        updated_at: now,
      };
      const voiceprint: Voiceprint = {
        _id: crypto.randomUUID(),
        owner_id: OWNER_ID,
        person_id: person._id,
        embedding: input.embedding,
        duration_ms: input.duration_ms,
        created_at: now,
      };
      await collections.people.insertOne(person);
      await collections.voiceprints.insertOne(voiceprint);
      await collections.utterances.updateMany(
        { _id: { $in: input.utterance_ids }, owner_id: OWNER_ID },
        {
          $set: {
            person_id: person._id,
            voiceprint_id: voiceprint._id,
            updated_at: now,
          },
        },
      );
      bus.emit({
        type: 'identity',
        conversation_id: input.conversation_id,
        person_id: person._id,
        voiceprint_id: voiceprint._id,
        name: person.name,
        utterance_ids: input.utterance_ids,
      });
      return { status: 'created', person_id: person._id, voiceprint_id: voiceprint._id };
    },
    async isOwnerVoice(embedding) {
      const owner = await collections.people.findOne({ owner_id: OWNER_ID, is_owner: true });
      if (!owner) return { authorized: false, confidence: 0 };

      const voiceprints = await collections.voiceprints.find({
        owner_id: OWNER_ID,
        person_id: owner._id,
      }).toArray();
      if (voiceprints.length === 0) return { authorized: false, confidence: 0 };

      const confidence = Math.max(
        ...voiceprints.map((voiceprint) => dotProduct(voiceprint.embedding, embedding)),
      );
      return { authorized: confidence >= OWNER_AUTH_THRESHOLD, confidence };
    },
    async enroll(request) {
      if (!request.embedding || request.embedding.length !== VOICEPRINT_DIMS) {
        throw new Error(`Voiceprint embeddings must have ${VOICEPRINT_DIMS} dimensions`);
      }

      let person: Person | null;
      if (request.person_id) {
        person = await collections.people.findOne({
          _id: request.person_id,
          owner_id: OWNER_ID,
        });
        if (!person) throw new Error(`Unknown person: ${request.person_id}`);
      } else {
        const now = timestamp();
        person = {
          _id: crypto.randomUUID(),
          owner_id: OWNER_ID,
          name: request.name ?? 'Unknown',
          created_at: now,
          updated_at: now,
        };
        await collections.people.insertOne(person);
      }

      const voiceprint: Voiceprint = {
        _id: crypto.randomUUID(),
        owner_id: OWNER_ID,
        person_id: person._id,
        embedding: request.embedding,
        duration_ms: request.duration_ms,
        ...(request.utterance_id ? { source_utterance_id: request.utterance_id } : {}),
        created_at: timestamp(),
      };
      await collections.voiceprints.insertOne(voiceprint);
      const { embedding: _embedding, ...publicVoiceprint } = voiceprint;
      return { person, voiceprint: publicVoiceprint };
    },
    async namePerson(personId, request) {
      const person = await collections.people.findOne({ _id: personId, owner_id: OWNER_ID });
      if (!person) throw new Error(`Unknown person: ${personId}`);

      const changes: Partial<Person> = {
        name: request.name,
        updated_at: timestamp(),
        ...(request.relationship !== undefined ? { relationship: request.relationship } : {}),
      };
      await collections.people.updateOne(
        { _id: personId, owner_id: OWNER_ID },
        { $set: changes },
      );
      const updatedPerson = { ...person, ...changes };
      const utterances = await collections.utterances.find({
        owner_id: OWNER_ID,
        person_id: personId,
      }).toArray();
      const utterancesByConversation = new Map<string, string[]>();
      for (const utterance of utterances) {
        const utteranceIds = utterancesByConversation.get(utterance.conversation_id) ?? [];
        utteranceIds.push(utterance._id);
        utterancesByConversation.set(utterance.conversation_id, utteranceIds);
      }
      for (const [conversationId, utteranceIds] of utterancesByConversation) {
        bus.emit({
          type: 'identity',
          conversation_id: conversationId,
          person_id: personId,
          name: updatedPerson.name,
          utterance_ids: utteranceIds,
        });
      }
      return updatedPerson;
    },
    async mergePeople(request) {
      const personIds = [...new Set(request.person_ids)];
      if (personIds.length < 2) throw new Error('At least two people are required to merge');

      const people = await collections.people.find({
        _id: { $in: personIds },
        owner_id: OWNER_ID,
      }).toArray();
      if (people.length !== personIds.length) throw new Error('Cannot merge unknown people');

      const survivor = people.reduce((oldest, person) => (
        person.created_at < oldest.created_at ? person : oldest
      ));
      const loserIds = personIds.filter((personId) => personId !== survivor._id);
      const affectedFilter = { owner_id: OWNER_ID, person_id: { $in: loserIds } };
      const conversationIds = (await collections.utterances.distinct(
        'conversation_id',
        affectedFilter,
      )).filter((id): id is string => typeof id === 'string');
      const affectedUtterances = await collections.utterances.find(affectedFilter).toArray();

      await collections.voiceprints.updateMany(affectedFilter, {
        $set: { person_id: survivor._id },
      });
      await collections.utterances.updateMany(affectedFilter, {
        $set: { person_id: survivor._id, updated_at: timestamp() },
      });
      await collections.facts.updateMany(affectedFilter, {
        $set: { person_id: survivor._id },
      });
      await collections.promises.updateMany(affectedFilter, {
        $set: { person_id: survivor._id },
      });
      await collections.people.deleteMany({
        _id: { $in: loserIds },
        owner_id: OWNER_ID,
      });

      for (const conversationId of conversationIds) {
        bus.emit({
          type: 'identity',
          conversation_id: conversationId,
          person_id: survivor._id,
          name: survivor.name,
          utterance_ids: affectedUtterances
            .filter((utterance) => utterance.conversation_id === conversationId)
            .map((utterance) => utterance._id),
        });
      }
      return survivor;
    },
  };
}
