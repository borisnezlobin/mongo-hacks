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
  OWNER_ID,
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
        const confidence = voiceprint.embedding.reduce(
          (score, component, index) => score + component * (input.embedding[index] ?? 0),
          0,
        );
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

      throw new Error('Not implemented');
    },
    async isOwnerVoice() {
      throw new Error('Not implemented');
    },
    async enroll() {
      throw new Error('Not implemented');
    },
    async namePerson() {
      throw new Error('Not implemented');
    },
    async mergePeople() {
      throw new Error('Not implemented');
    },
  };
}
