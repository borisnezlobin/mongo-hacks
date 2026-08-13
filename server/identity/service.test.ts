import { describe, expect, it, vi } from 'vitest';
import type { Fact, Person, PromiseMemory, Utterance, Voiceprint } from '../../shared/contracts';
import { EMBED_MIN_MS, OWNER_ID } from '../../shared/contracts';
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
});
