import { afterEach, describe, expect, it, vi } from 'vitest';
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

  aggregate<TResult extends object>(pipeline: Record<string, unknown>[]) {
    const vectorStage = pipeline[0].$vectorSearch as {
      queryVector: number[];
      filter: Filter;
      limit: number;
    };
    const results = this.documents
      .filter((document) => matches(document, vectorStage.filter))
      .map((document) => {
        const embedding = (document as unknown as { embedding?: number[] }).embedding ?? [];
        const rawCosine = embedding.reduce(
          (score, component, index) => score + component * (vectorStage.queryVector[index] ?? 0),
          0,
        );
        return { ...structuredClone(document), score: (rawCosine + 1) / 2 };
      })
      .sort((left, right) => right.score - left.score)
      .slice(0, vectorStage.limit) as unknown as TResult[];
    return { toArray: async () => results };
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

  /**
   * Found in the live database: 6 of 11 voiceprints pointed at people that no
   * longer existed, including the owner's own enrollment. An orphan still wins
   * the vector search, and throwing on it took attribution down for that
   * speaker for the whole conversation — the session swallows the error, hits
   * the same orphan next chunk, and nobody is ever named.
   */
  it('skips an orphaned voiceprint and matches the next real person', async () => {
    const harness = createHarness({
      people: [{
        _id: 'person-1',
        owner_id: OWNER_ID,
        name: 'Sam',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      }],
      voiceprints: [
        {
          // Nearer match, but its person was merged away long ago.
          _id: 'voiceprint-orphan',
          owner_id: OWNER_ID,
          person_id: 'person-deleted',
          embedding: [0.95, 0.31],
          duration_ms: 4_000,
          created_at: '2026-01-01T00:00:00.000Z',
        },
        {
          _id: 'voiceprint-1',
          owner_id: OWNER_ID,
          person_id: 'person-1',
          embedding: [0.8, 0.6],
          duration_ms: 4_000,
          created_at: '2026-01-01T00:00:00.000Z',
        },
      ],
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

    expect(result).toMatchObject({ status: 'matched', person_id: 'person-1' });
  });

  it('creates a new person when every candidate is orphaned', async () => {
    const harness = createHarness({
      voiceprints: [{
        _id: 'voiceprint-orphan',
        owner_id: OWNER_ID,
        person_id: 'person-deleted',
        embedding: [1, 0],
        duration_ms: 4_000,
        created_at: '2026-01-01T00:00:00.000Z',
      }],
    });

    const result = await harness.service.attributeSpeaker({
      embedding: [1, 0],
      duration_ms: EMBED_MIN_MS,
      conversation_id: 'conversation-1',
      utterance_ids: ['utterance-1'],
    });

    // Not an exception, and not silence: a nameless speaker we can name later.
    expect(result.status).toBe('created');
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

function personFixture(id: string, name: string): Person {
  return {
    _id: id,
    owner_id: OWNER_ID,
    name,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

/**
 * The fake $vectorSearch dots the stored embedding with the query, so an
 * embedding of `[cosine, 0]` against a query of `[1, 0]` scores exactly the
 * cosine asked for. That makes every margin in these tests arithmetic rather
 * than a guess about vector geometry.
 */
function voiceprintFixture(id: string, personId: string, cosine: number): Voiceprint {
  return {
    _id: id,
    owner_id: OWNER_ID,
    person_id: personId,
    embedding: [cosine, 0],
    duration_ms: 4_000,
    created_at: '2026-01-01T00:00:00.000Z',
  };
}

const QUERY = [1, 0];

function attribute(
  harness: ReturnType<typeof createHarness>,
  extra: { final?: boolean } = {},
) {
  return harness.service.attributeSpeaker({
    embedding: QUERY,
    duration_ms: EMBED_MIN_MS,
    conversation_id: 'conversation-margin',
    utterance_ids: ['utterance-margin'],
    ...extra,
  });
}

describe('identity service speaker margin', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  /**
   * The whole point of the opt-in: five people share this main, and an unset
   * IDENTITY_MARGIN_COSINE has to mean "the code that shipped last week". Two
   * rivals two hundredths apart is precisely the input the margin was built to
   * hold back, so if the default ever stops being zero this is the test that
   * notices.
   */
  it('still picks the nearest of two close rivals when no margin is configured', async () => {
    const harness = createHarness({
      people: [personFixture('person-1', 'Sam'), personFixture('person-2', 'Alex')],
      voiceprints: [
        voiceprintFixture('voiceprint-1', 'person-1', 0.9),
        voiceprintFixture('voiceprint-2', 'person-2', 0.88),
      ],
    });

    const result = await attribute(harness);

    expect(result).toEqual({
      status: 'matched',
      person_id: 'person-1',
      voiceprint_id: 'voiceprint-1',
      confidence: 0.9,
    });
    expect(harness.emit).toHaveBeenCalledTimes(1);
  });

  it('mints a new person below the threshold when no margin is configured', async () => {
    const harness = createHarness({
      people: [personFixture('person-1', 'Sam')],
      voiceprints: [voiceprintFixture('voiceprint-1', 'person-1', 0.4)],
    });

    const result = await attribute(harness);

    expect(result.status).toBe('created');
    expect(harness.people.documents).toHaveLength(2);
  });

  it('holds two close rivals as ambiguous once a margin is configured', async () => {
    vi.stubEnv('IDENTITY_MARGIN_COSINE', '0.05');
    const harness = createHarness({
      people: [personFixture('person-1', 'Sam'), personFixture('person-2', 'Alex')],
      voiceprints: [
        voiceprintFixture('voiceprint-1', 'person-1', 0.9),
        voiceprintFixture('voiceprint-2', 'person-2', 0.88),
      ],
    });

    const result = await attribute(harness);

    // Waiting must be free of side effects, or a retry would double-write.
    expect(result).toEqual({ status: 'pending', reason: 'ambiguous' });
    expect(harness.emit).not.toHaveBeenCalled();
    expect(harness.people.documents).toHaveLength(2);
    expect(harness.voiceprints.documents).toHaveLength(2);
  });

  it('takes the top candidate on the final attempt rather than staying nameless', async () => {
    vi.stubEnv('IDENTITY_MARGIN_COSINE', '0.05');
    const harness = createHarness({
      people: [personFixture('person-1', 'Sam'), personFixture('person-2', 'Alex')],
      voiceprints: [
        voiceprintFixture('voiceprint-1', 'person-1', 0.9),
        voiceprintFixture('voiceprint-2', 'person-2', 0.88),
      ],
    });

    const result = await attribute(harness, { final: true });

    expect(result).toEqual({
      status: 'matched',
      person_id: 'person-1',
      voiceprint_id: 'voiceprint-1',
      confidence: 0.9,
    });
  });

  it('matches when the winner clears the runner-up by more than the margin', async () => {
    vi.stubEnv('IDENTITY_MARGIN_COSINE', '0.05');
    const harness = createHarness({
      people: [personFixture('person-1', 'Sam'), personFixture('person-2', 'Alex')],
      voiceprints: [
        voiceprintFixture('voiceprint-1', 'person-1', 0.9),
        voiceprintFixture('voiceprint-2', 'person-2', 0.7),
      ],
    });

    await expect(attribute(harness)).resolves.toMatchObject({
      status: 'matched',
      person_id: 'person-1',
    });
  });

  it('mints a new person when every candidate is below the threshold under a margin', async () => {
    vi.stubEnv('IDENTITY_MARGIN_COSINE', '0.05');
    const harness = createHarness({
      people: [personFixture('person-1', 'Sam'), personFixture('person-2', 'Alex')],
      voiceprints: [
        voiceprintFixture('voiceprint-1', 'person-1', 0.5),
        voiceprintFixture('voiceprint-2', 'person-2', 0.49),
      ],
    });

    const result = await attribute(harness);

    expect(result.status).toBe('created');
    expect(harness.people.documents).toHaveLength(3);
  });

  /**
   * A margin makes the walk go two people deep, which is exactly where the
   * orphan skip could have been lost: the orphan now sits between the winner
   * and the runner-up instead of in front of a single candidate.
   */
  it('skips an orphan while still measuring the margin between the two real people', async () => {
    vi.stubEnv('IDENTITY_MARGIN_COSINE', '0.05');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const harness = createHarness({
      people: [personFixture('person-1', 'Sam'), personFixture('person-2', 'Alex')],
      voiceprints: [
        voiceprintFixture('voiceprint-orphan', 'person-deleted', 0.95),
        voiceprintFixture('voiceprint-1', 'person-1', 0.9),
        voiceprintFixture('voiceprint-2', 'person-2', 0.88),
      ],
    });

    await expect(attribute(harness)).resolves.toEqual({ status: 'pending', reason: 'ambiguous' });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('matches past an orphan when the two real people are far apart', async () => {
    vi.stubEnv('IDENTITY_MARGIN_COSINE', '0.05');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const harness = createHarness({
      people: [personFixture('person-1', 'Sam'), personFixture('person-2', 'Alex')],
      voiceprints: [
        voiceprintFixture('voiceprint-orphan', 'person-deleted', 0.95),
        voiceprintFixture('voiceprint-1', 'person-1', 0.9),
        voiceprintFixture('voiceprint-2', 'person-2', 0.7),
      ],
    });

    await expect(attribute(harness)).resolves.toMatchObject({
      status: 'matched',
      person_id: 'person-1',
      voiceprint_id: 'voiceprint-1',
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  /**
   * The first person ever enrolled has nobody to be compared against. A margin
   * computed as best-minus-nothing is the classic way to make that person
   * permanently unattributable, so both of the smallest possible databases are
   * pinned here.
   */
  it('attributes the only person in the database under a margin', async () => {
    vi.stubEnv('IDENTITY_MARGIN_COSINE', '0.05');
    const harness = createHarness({
      people: [personFixture('person-1', 'Sam')],
      voiceprints: [voiceprintFixture('voiceprint-1', 'person-1', 0.9)],
    });

    const result = await attribute(harness);

    expect(result).toMatchObject({ status: 'matched', person_id: 'person-1' });
    expect(result.status === 'matched' && Number.isFinite(result.confidence)).toBe(true);
  });

  it('survives an empty database under a margin', async () => {
    vi.stubEnv('IDENTITY_MARGIN_COSINE', '0.05');
    const harness = createHarness();

    await expect(attribute(harness)).resolves.toMatchObject({ status: 'created' });
  });

  it('attributes when only one of two enrolled people clears the threshold', async () => {
    vi.stubEnv('IDENTITY_MARGIN_COSINE', '0.5');
    const harness = createHarness({
      people: [personFixture('person-1', 'Sam'), personFixture('person-2', 'Alex')],
      voiceprints: [
        voiceprintFixture('voiceprint-1', 'person-1', 0.9),
        // Below ATTRIBUTION_THRESHOLD, so the walk stops before it and it is
        // not a rival at all — otherwise a 0.5 margin would swallow this match.
        voiceprintFixture('voiceprint-2', 'person-2', 0.55),
      ],
    });

    await expect(attribute(harness)).resolves.toMatchObject({
      status: 'matched',
      person_id: 'person-1',
    });
  });

  /**
   * Somebody who has enrolled twice is their own nearest neighbour. Comparing
   * rows instead of people would make every well-enrolled person ambiguous
   * forever — the more audio you give Amelia about someone, the less it could
   * recognise them.
   */
  it('does not treat a person second voiceprint as a rival', async () => {
    vi.stubEnv('IDENTITY_MARGIN_COSINE', '0.05');
    const harness = createHarness({
      people: [personFixture('person-1', 'Sam'), personFixture('person-2', 'Alex')],
      voiceprints: [
        voiceprintFixture('voiceprint-1a', 'person-1', 0.95),
        voiceprintFixture('voiceprint-1b', 'person-1', 0.93),
        voiceprintFixture('voiceprint-2', 'person-2', 0.7),
      ],
    });

    await expect(attribute(harness)).resolves.toEqual({
      status: 'matched',
      person_id: 'person-1',
      voiceprint_id: 'voiceprint-1a',
      confidence: 0.95,
    });
  });

  /**
   * Deduping rivals by person only helps if the rival is inside the search
   * window at all. A person who has enrolled a few times — or who survived a
   * merge, which repoints every loser print onto them — can fill a three-row
   * window on their own, and the runner-up the margin is measured against then
   * never exists. The blind spot would be worst for exactly the people Amelia
   * knows best.
   */
  it('sees the runner-up past a person who owns more prints than the old window held', async () => {
    vi.stubEnv('IDENTITY_MARGIN_COSINE', '0.05');
    const harness = createHarness({
      people: [personFixture('person-1', 'Sam'), personFixture('person-2', 'Alex')],
      voiceprints: [
        voiceprintFixture('voiceprint-1a', 'person-1', 0.95),
        voiceprintFixture('voiceprint-1b', 'person-1', 0.94),
        voiceprintFixture('voiceprint-1c', 'person-1', 0.93),
        voiceprintFixture('voiceprint-1d', 'person-1', 0.92),
        voiceprintFixture('voiceprint-2', 'person-2', 0.91),
      ],
    });

    await expect(attribute(harness)).resolves.toEqual({ status: 'pending', reason: 'ambiguous' });
  });

  /**
   * The wider window is part of the margin, not a free upgrade: with the margin
   * off nothing past the first live candidate can change the answer, and this
   * path must keep asking Atlas for exactly what it always asked for.
   */
  it('leaves the search window at three rows when no margin is configured', async () => {
    const harness = createHarness({
      people: [personFixture('person-1', 'Sam')],
      voiceprints: [voiceprintFixture('voiceprint-1', 'person-1', 0.9)],
    });
    const aggregate = vi.spyOn(harness.voiceprints, 'aggregate');

    await attribute(harness);

    const [pipeline] = aggregate.mock.calls[0] as [Record<string, unknown>[]];
    expect((pipeline[0].$vectorSearch as { limit: number }).limit).toBe(3);
  });

  /**
   * A copied .env.example ships this blank, and Number('') is 0 — which reads
   * as "margin off" only by luck here, and as "safety disabled" everywhere
   * else. Blank means default, not zero.
   */
  it('treats a blank margin as unset rather than as a number', async () => {
    vi.stubEnv('IDENTITY_MARGIN_COSINE', '');
    const harness = createHarness({
      people: [personFixture('person-1', 'Sam'), personFixture('person-2', 'Alex')],
      voiceprints: [
        voiceprintFixture('voiceprint-1', 'person-1', 0.9),
        voiceprintFixture('voiceprint-2', 'person-2', 0.88),
      ],
    });

    await expect(attribute(harness)).resolves.toMatchObject({
      status: 'matched',
      person_id: 'person-1',
    });
  });

  it('falls back to the contract threshold when the override is blank', async () => {
    vi.stubEnv('ATTRIBUTION_THRESHOLD', '');
    const harness = createHarness({
      people: [personFixture('person-1', 'Sam')],
      voiceprints: [voiceprintFixture('voiceprint-1', 'person-1', 0.4)],
    });

    // A blank threshold parsed as 0 would attribute this stranger to Sam.
    await expect(attribute(harness)).resolves.toMatchObject({ status: 'created' });
  });

  it('leaves a below-floor sample pending even with a margin configured', async () => {
    vi.stubEnv('IDENTITY_MARGIN_COSINE', '0.05');
    const harness = createHarness();

    const result = await harness.service.attributeSpeaker({
      embedding: QUERY,
      duration_ms: EMBED_MIN_MS - 1,
      conversation_id: 'conversation-margin',
      utterance_ids: ['utterance-margin'],
    });

    expect(result).toEqual({ status: 'pending', reason: 'below_floor' });
  });
});
