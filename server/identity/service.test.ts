import { describe, expect, it, vi } from 'vitest';
import type { Fact, Person, PromiseMemory, Utterance, Voiceprint } from '../../shared/contracts';
import { EMBED_MIN_MS, OWNER_ID, VOICEPRINT_DIMS } from '../../shared/contracts';
import { createIdentityService } from './service';

type Filter = Record<string, unknown>;

function matches<T extends { _id: string }>(document: T, filter: Filter): boolean {
  const values = document as unknown as Record<string, unknown>;
  return Object.entries(filter).every(([key, expected]) => {
    if (typeof expected === 'object' && expected !== null && '$in' in expected) {
      return (expected.$in as unknown[]).includes(values[key]);
    }
    return values[key] === expected;
  });
}

class FakeCollection<T extends { _id: string }> {
  readonly documents: T[];

  constructor(documents: T[] = []) {
    this.documents = structuredClone(documents);
  }

  async insertOne(document: T) {
    this.documents.push(structuredClone(document));
    return { insertedId: document._id };
  }

  find(filter: Filter = {}) {
    return {
      toArray: async () => structuredClone(this.documents.filter((document) => matches(document, filter))),
    };
  }

  async findOne(filter: Filter) {
    const document = this.documents.find((candidate) => matches(candidate, filter));
    return document ? structuredClone(document) : null;
  }

  async updateOne(filter: Filter, update: { $set: Partial<T> }) {
    const document = this.documents.find((candidate) => matches(candidate, filter));
    if (document) Object.assign(document, structuredClone(update.$set));
    return { matchedCount: document ? 1 : 0, modifiedCount: document ? 1 : 0 };
  }

  async updateMany(filter: Filter, update: { $set: Partial<T> }) {
    const documents = this.documents.filter((candidate) => matches(candidate, filter));
    for (const document of documents) Object.assign(document, structuredClone(update.$set));
    return { matchedCount: documents.length, modifiedCount: documents.length };
  }

  async deleteMany(filter: Filter) {
    const retained = this.documents.filter((candidate) => !matches(candidate, filter));
    const deletedCount = this.documents.length - retained.length;
    this.documents.splice(0, this.documents.length, ...retained);
    return { deletedCount };
  }

  async distinct(key: string, filter: Filter) {
    return [...new Set(
      this.documents
        .filter((document) => matches(document, filter))
        .map((document) => (document as unknown as Record<string, unknown>)[key]),
    )];
  }
}

interface InitialCollections {
  people: Person[];
  voiceprints: Voiceprint[];
  utterances: Utterance[];
  facts: Fact[];
  promises: PromiseMemory[];
}

function createHarness(initial: Partial<InitialCollections> = {}) {
  const people = new FakeCollection<Person>(initial.people);
  const voiceprints = new FakeCollection<Voiceprint>(initial.voiceprints);
  const utterances = new FakeCollection<Utterance>(initial.utterances);
  const facts = new FakeCollection<Fact>(initial.facts);
  const promises = new FakeCollection<PromiseMemory>(initial.promises);
  const emit = vi.fn();
  const service = createIdentityService({
    collections: { people, voiceprints, utterances, facts, promises },
    bus: { emit, subscribe: vi.fn(() => () => {}) },
    now: () => new Date('2026-08-13T12:00:00.000Z'),
  });

  return { service, people, voiceprints, utterances, facts, promises, emit };
}

describe('identity service', () => {
  it('leaves below-floor speaker samples pending without writes', async () => {
    const harness = createHarness();

    const result = await harness.service.attributeSpeaker({
      embedding: [1, 0],
      duration_ms: EMBED_MIN_MS - 1,
      conversation_id: 'conversation-1',
      utterance_ids: ['utterance-1'],
    });

    expect(result).toEqual({ status: 'pending', reason: 'below_floor' });
    expect(harness.people.documents).toEqual([]);
    expect(harness.voiceprints.documents).toEqual([]);
    expect(harness.utterances.documents).toEqual([]);
    expect(harness.emit).not.toHaveBeenCalled();
  });

  it('attributes a known voice and publishes the identity', async () => {
    const harness = createHarness({
      people: [{
        _id: 'person-1',
        owner_id: OWNER_ID,
        name: 'Sam',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      }],
      voiceprints: [{
        _id: 'voiceprint-1',
        owner_id: OWNER_ID,
        person_id: 'person-1',
        embedding: [0.8, 0.6],
        duration_ms: 4_000,
        created_at: '2026-01-01T00:00:00.000Z',
      }],
      utterances: [{
        _id: 'utterance-1',
        owner_id: OWNER_ID,
        conversation_id: 'conversation-1',
        text: 'Hello',
        start_ms: 0,
        end_ms: 3_000,
        is_final: true,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      }],
    });

    const result = await harness.service.attributeSpeaker({
      embedding: [1, 0],
      duration_ms: EMBED_MIN_MS,
      conversation_id: 'conversation-1',
      utterance_ids: ['utterance-1'],
    });

    expect(result).toEqual({
      status: 'matched',
      person_id: 'person-1',
      voiceprint_id: 'voiceprint-1',
      confidence: 0.8,
    });
    expect(harness.utterances.documents[0]).toMatchObject({
      person_id: 'person-1',
      voiceprint_id: 'voiceprint-1',
      updated_at: '2026-08-13T12:00:00.000Z',
    });
    expect(harness.emit).toHaveBeenCalledWith({
      type: 'identity',
      conversation_id: 'conversation-1',
      person_id: 'person-1',
      voiceprint_id: 'voiceprint-1',
      name: 'Sam',
      utterance_ids: ['utterance-1'],
    });
  });

  it('creates an unknown person and voiceprint for a new voice', async () => {
    const harness = createHarness({
      utterances: [{
        _id: 'utterance-new',
        owner_id: OWNER_ID,
        conversation_id: 'conversation-new',
        text: 'A new speaker',
        start_ms: 0,
        end_ms: 3_500,
        is_final: true,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      }],
    });

    const result = await harness.service.attributeSpeaker({
      embedding: [0, 1],
      duration_ms: 3_500,
      conversation_id: 'conversation-new',
      utterance_ids: ['utterance-new'],
    });

    expect(result.status).toBe('created');
    expect(harness.people.documents).toHaveLength(1);
    expect(harness.people.documents[0]).toMatchObject({
      owner_id: OWNER_ID,
      name: 'Unknown',
      created_at: '2026-08-13T12:00:00.000Z',
      updated_at: '2026-08-13T12:00:00.000Z',
    });
    expect(harness.people.documents[0]).not.toHaveProperty('is_owner');
    expect(harness.voiceprints.documents).toHaveLength(1);
    expect(harness.voiceprints.documents[0]).toMatchObject({
      owner_id: OWNER_ID,
      person_id: harness.people.documents[0]._id,
      embedding: [0, 1],
      duration_ms: 3_500,
      created_at: '2026-08-13T12:00:00.000Z',
    });
    expect(harness.utterances.documents[0]).toMatchObject({
      person_id: harness.people.documents[0]._id,
      voiceprint_id: harness.voiceprints.documents[0]._id,
      updated_at: '2026-08-13T12:00:00.000Z',
    });
    expect(harness.emit).toHaveBeenCalledWith({
      type: 'identity',
      conversation_id: 'conversation-new',
      person_id: harness.people.documents[0]._id,
      voiceprint_id: harness.voiceprints.documents[0]._id,
      name: 'Unknown',
      utterance_ids: ['utterance-new'],
    });
  });

  it('authorizes only owner voices at or above the owner threshold', async () => {
    const harness = createHarness({
      people: [{
        _id: 'owner-person',
        owner_id: OWNER_ID,
        name: 'Owner',
        is_owner: true,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      }],
      voiceprints: [{
        _id: 'owner-voiceprint',
        owner_id: OWNER_ID,
        person_id: 'owner-person',
        embedding: [1, 0],
        duration_ms: 4_000,
        created_at: '2026-01-01T00:00:00.000Z',
      }],
    });

    await expect(harness.service.isOwnerVoice([0.6, 0.8])).resolves.toEqual({
      authorized: true,
      confidence: 0.6,
    });
    await expect(harness.service.isOwnerVoice([0.59, 0.8074])).resolves.toEqual({
      authorized: false,
      confidence: 0.59,
    });
  });

  it('rejects owner authorization when no owner is enrolled', async () => {
    const harness = createHarness();

    await expect(harness.service.isOwnerVoice([1, 0])).resolves.toEqual({
      authorized: false,
      confidence: 0,
    });
  });

  it('rejects enrollment embeddings with the wrong dimensions', async () => {
    const harness = createHarness();

    await expect(harness.service.enroll({
      name: 'Taylor',
      duration_ms: 4_000,
      embedding: Array(VOICEPRINT_DIMS - 1).fill(0),
    })).rejects.toThrow('192 dimensions');
    expect(harness.people.documents).toEqual([]);
    expect(harness.voiceprints.documents).toEqual([]);
  });

  it('reuses an enrolled person and omits the embedding from the response', async () => {
    const harness = createHarness({
      people: [{
        _id: 'person-enrolled',
        owner_id: OWNER_ID,
        name: 'Taylor',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      }],
    });
    const embedding = Array(VOICEPRINT_DIMS).fill(0);

    const result = await harness.service.enroll({
      person_id: 'person-enrolled',
      utterance_id: 'utterance-source',
      duration_ms: 4_000,
      embedding,
    });

    expect(result.person._id).toBe('person-enrolled');
    expect(result.voiceprint).not.toHaveProperty('embedding');
    expect(result.voiceprint).toMatchObject({
      owner_id: OWNER_ID,
      person_id: 'person-enrolled',
      source_utterance_id: 'utterance-source',
      duration_ms: 4_000,
      created_at: '2026-08-13T12:00:00.000Z',
    });
    expect(harness.people.documents).toHaveLength(1);
    expect(harness.voiceprints.documents[0].embedding).toEqual(embedding);
  });

  it('renames a person and emits relabel events for their utterances', async () => {
    const harness = createHarness({
      people: [{
        _id: 'person-unknown',
        owner_id: OWNER_ID,
        name: 'Unknown',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      }],
      utterances: [{
        _id: 'utterance-name',
        owner_id: OWNER_ID,
        conversation_id: 'conversation-name',
        person_id: 'person-unknown',
        text: 'My name is Jordan',
        start_ms: 0,
        end_ms: 2_000,
        is_final: true,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      }],
    });

    const person = await harness.service.namePerson('person-unknown', {
      name: 'Jordan',
      relationship: 'Friend',
    });

    expect(person).toMatchObject({
      name: 'Jordan',
      relationship: 'Friend',
      updated_at: '2026-08-13T12:00:00.000Z',
    });
    expect(harness.people.documents[0]).toEqual(person);
    expect(harness.emit).toHaveBeenCalledWith({
      type: 'identity',
      conversation_id: 'conversation-name',
      person_id: 'person-unknown',
      name: 'Jordan',
      utterance_ids: ['utterance-name'],
    });
  });

  it('merges into the oldest person and preserves every voiceprint', async () => {
    const harness = createHarness({
      people: [
        {
          _id: 'person-newer',
          owner_id: OWNER_ID,
          name: 'Newer record',
          created_at: '2026-01-02T00:00:00.000Z',
          updated_at: '2026-01-02T00:00:00.000Z',
        },
        {
          _id: 'person-oldest',
          owner_id: OWNER_ID,
          name: 'Oldest record',
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
        {
          _id: 'person-newest',
          owner_id: OWNER_ID,
          name: 'Newest record',
          created_at: '2026-01-03T00:00:00.000Z',
          updated_at: '2026-01-03T00:00:00.000Z',
        },
      ],
      voiceprints: [
        {
          _id: 'voiceprint-oldest',
          owner_id: OWNER_ID,
          person_id: 'person-oldest',
          embedding: [1, 0],
          duration_ms: 4_000,
          created_at: '2026-01-01T00:00:00.000Z',
        },
        {
          _id: 'voiceprint-newer',
          owner_id: OWNER_ID,
          person_id: 'person-newer',
          embedding: [0, 1],
          duration_ms: 4_000,
          created_at: '2026-01-02T00:00:00.000Z',
        },
        {
          _id: 'voiceprint-newest',
          owner_id: OWNER_ID,
          person_id: 'person-newest',
          embedding: [-1, 0],
          duration_ms: 4_000,
          created_at: '2026-01-03T00:00:00.000Z',
        },
      ],
      utterances: [
        {
          _id: 'utterance-1',
          owner_id: OWNER_ID,
          conversation_id: 'conversation-1',
          person_id: 'person-newer',
          text: 'First',
          start_ms: 0,
          end_ms: 1_000,
          is_final: true,
          created_at: '2026-01-02T00:00:00.000Z',
          updated_at: '2026-01-02T00:00:00.000Z',
        },
        {
          _id: 'utterance-2',
          owner_id: OWNER_ID,
          conversation_id: 'conversation-2',
          person_id: 'person-newest',
          text: 'Second',
          start_ms: 0,
          end_ms: 1_000,
          is_final: true,
          created_at: '2026-01-03T00:00:00.000Z',
          updated_at: '2026-01-03T00:00:00.000Z',
        },
      ],
      facts: [{
        _id: 'fact-1',
        owner_id: OWNER_ID,
        person_id: 'person-newer',
        attribute: 'workplace',
        claim: 'Works at Amelia',
        claim_normalized: 'works at amelia',
        primary_source_utterance_id: 'utterance-1',
        valid_from: '2026-01-02T00:00:00.000Z',
        created_at: '2026-01-02T00:00:00.000Z',
      }],
      promises: [{
        _id: 'promise-1',
        owner_id: OWNER_ID,
        person_id: 'person-newest',
        source_utterance_id: 'utterance-2',
        text: 'Will follow up',
        text_normalized: 'will follow up',
        status: 'open',
        created_at: '2026-01-03T00:00:00.000Z',
      }],
    });

    const survivor = await harness.service.mergePeople({
      person_ids: ['person-newer', 'person-oldest', 'person-newest'],
    });

    expect(survivor._id).toBe('person-oldest');
    expect(harness.people.documents.map((person) => person._id)).toEqual(['person-oldest']);
    expect(harness.voiceprints.documents).toHaveLength(3);
    expect(harness.voiceprints.documents.every(
      (voiceprint) => voiceprint.person_id === 'person-oldest',
    )).toBe(true);
    expect(harness.utterances.documents.every(
      (utterance) => utterance.person_id === 'person-oldest',
    )).toBe(true);
    expect(harness.facts.documents[0].person_id).toBe('person-oldest');
    expect(harness.promises.documents[0].person_id).toBe('person-oldest');
    expect(harness.emit).toHaveBeenCalledTimes(2);
    expect(harness.emit).toHaveBeenCalledWith({
      type: 'identity',
      conversation_id: 'conversation-1',
      person_id: 'person-oldest',
      name: 'Oldest record',
      utterance_ids: ['utterance-1'],
    });
    expect(harness.emit).toHaveBeenCalledWith({
      type: 'identity',
      conversation_id: 'conversation-2',
      person_id: 'person-oldest',
      name: 'Oldest record',
      utterance_ids: ['utterance-2'],
    });
  });
});
