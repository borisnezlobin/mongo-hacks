import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Fact, Person, PromiseMemory, Utterance, Voiceprint } from '../../shared/contracts';
import {
  ATTRIBUTION_MARGIN,
  ATTRIBUTION_THRESHOLD,
  CONFIRMED_SPEECH_MS,
  CROSS_SESSION_SPEECH_MS,
  EMBED_MIN_MS,
  MAX_VOICEPRINTS_PER_PERSON,
  OWNER_AUTH_THRESHOLD,
  OWNER_ID,
  PROVISIONAL_SPEECH_MS,
  VOICEPRINT_DIMS,
} from '../../shared/contracts';
import { UNNAMED_PERSON_NAME, createIdentityService } from './service';

type Filter = Record<string, unknown>;
type StoredVoiceprint = Voiceprint & { enrolled?: boolean };

function matches<T extends { _id: string }>(document: T, filter: Filter): boolean {
  const values = document as unknown as Record<string, unknown>;
  return Object.entries(filter).every(([key, expected]) => {
    if (typeof expected === 'object' && expected !== null && '$in' in expected) {
      return (expected.$in as unknown[]).includes(values[key]);
    }
    return values[key] === expected;
  });
}

/**
 * Deliberately has no `aggregate`: identification must work against a plain
 * collection, because Atlas `$vectorSearch` is not reachable from the venue
 * network and the owner has no dashboard to fix an index with.
 */
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
      toArray: async () =>
        structuredClone(this.documents.filter((document) => matches(document, filter))),
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
    return [
      ...new Set(
        this.documents
          .filter((document) => matches(document, filter))
          .map((document) => (document as unknown as Record<string, unknown>)[key]),
      ),
    ];
  }
}

interface InitialCollections {
  people: Person[];
  voiceprints: StoredVoiceprint[];
  utterances: Utterance[];
  facts: Fact[];
  promises: PromiseMemory[];
}

const AT = '2026-01-01T00:00:00.000Z';
const NOW = '2026-08-13T12:00:00.000Z';

function person(id: string, name: string, extra: Partial<Person> = {}): Person {
  return { _id: id, owner_id: OWNER_ID, name, created_at: AT, updated_at: AT, ...extra };
}

function voiceprint(
  id: string,
  personId: string,
  embedding: number[],
  extra: Partial<StoredVoiceprint> = {},
): StoredVoiceprint {
  return {
    _id: id,
    owner_id: OWNER_ID,
    person_id: personId,
    embedding,
    duration_ms: 25_000,
    created_at: AT,
    ...extra,
  };
}

function utterance(id: string, conversationId: string, extra: Partial<Utterance> = {}): Utterance {
  return {
    _id: id,
    owner_id: OWNER_ID,
    conversation_id: conversationId,
    text: 'Hello',
    start_ms: 0,
    end_ms: 3_000,
    is_final: true,
    created_at: AT,
    updated_at: AT,
    ...extra,
  };
}

/**
 * Measured on fixtures/real/cross-session.json, enrolling on the first half of
 * dorm-9pm and testing on the second: the tightest true match in the recording
 * scored 0.746, and the stranger who was never enrolled scored 0.619 against
 * his nearest neighbour. Fixtures here are built from those numbers rather than
 * from whatever the code returns, so a recalibration that closed the gap would
 * fail these tests instead of quietly redefining them.
 */
const TRUE_MATCH = 0.746;
const NEAREST_IMPOSTOR = 0.619;

/** A unit vector whose cosine against [1, 0, 0] is exactly `similarity`. */
function at(similarity: number): number[] {
  return [similarity, Math.sqrt(1 - similarity * similarity), 0];
}

function createHarness(initial: Partial<InitialCollections> = {}) {
  const people = new FakeCollection<Person>(initial.people);
  const voiceprints = new FakeCollection<StoredVoiceprint>(initial.voiceprints);
  const utterances = new FakeCollection<Utterance>(initial.utterances);
  const facts = new FakeCollection<Fact>(initial.facts);
  const promises = new FakeCollection<PromiseMemory>(initial.promises);
  const emit = vi.fn();
  const service = createIdentityService({
    collections: { people, voiceprints, utterances, facts, promises },
    bus: { emit, subscribe: vi.fn(() => () => {}) },
    now: () => new Date(NOW),
  });

  return { service, people, voiceprints, utterances, facts, promises, emit };
}

describe('attribution gates', () => {
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
    expect(harness.emit).not.toHaveBeenCalled();
  });

  /**
   * 2-6s of pooled speech identifies correctly 65-75% of the time. A name shown
   * at that accuracy is worse than no name, so nothing is claimed until
   * PROVISIONAL_SPEECH_MS even when a voiceprint matches perfectly.
   */
  it('says nothing at all below the provisional floor, however good the match', async () => {
    const harness = createHarness({
      people: [person('ann', 'Ann')],
      voiceprints: [voiceprint('print-ann', 'ann', [1, 0])],
    });

    const result = await harness.service.attributeSpeaker({
      embedding: [1, 0],
      duration_ms: PROVISIONAL_SPEECH_MS - 1,
      conversation_id: 'conversation-1',
      utterance_ids: ['utterance-1'],
    });

    expect(result).toEqual({ status: 'pending', reason: 'gathering' });
    expect(harness.emit).not.toHaveBeenCalled();
  });
});

describe('matching', () => {
  it('matches a known voice, reinforces it, and publishes a confirmed identity', async () => {
    const harness = createHarness({
      people: [person('ann', 'Ann')],
      voiceprints: [voiceprint('print-ann', 'ann', at(TRUE_MATCH), { session_mean: [0, 0, 1] })],
      utterances: [utterance('utterance-1', 'conversation-1')],
    });

    const result = await harness.service.attributeSpeaker({
      embedding: [1, 0, 0],
      session_mean: [0, 0, 2],
      duration_ms: CROSS_SESSION_SPEECH_MS,
      conversation_id: 'conversation-1',
      utterance_ids: ['utterance-1'],
    });

    expect(result).toMatchObject({
      status: 'matched',
      person_id: 'ann',
      identity_confidence: 'confirmed',
    });
    expect(harness.utterances.documents[0]).toMatchObject({
      person_id: 'ann',
      updated_at: NOW,
    });
    expect(harness.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'identity',
        conversation_id: 'conversation-1',
        person_id: 'ann',
        name: 'Ann',
        utterance_ids: ['utterance-1'],
        confidence: 'confirmed',
      }),
    );

    // The session that recognised her also becomes a print, so the next room works.
    expect(harness.voiceprints.documents).toHaveLength(2);
    const added = harness.voiceprints.documents.find((print) => print._id !== 'print-ann');
    expect(added).toMatchObject({
      person_id: 'ann',
      embedding: [1, 0, 0],
      // Still recorded on every print, for a future channel model. Not the gate.
      session_mean: [0, 0, 2],
      source_conversation_id: 'conversation-1',
    });
  });

  /**
   * A provisional claim is shown live as a guess. It must not be filed: facts
   * and promises are read back off utterance.person_id, and a wrong one there
   * is wrong forever.
   */
  it('shows a provisional match without filing it', async () => {
    const harness = createHarness({
      people: [person('ann', 'Ann')],
      voiceprints: [voiceprint('print-ann', 'ann', [1, 0])],
      utterances: [utterance('utterance-1', 'conversation-1')],
    });

    const result = await harness.service.attributeSpeaker({
      embedding: [1, 0],
      duration_ms: PROVISIONAL_SPEECH_MS,
      conversation_id: 'conversation-1',
      utterance_ids: ['utterance-1'],
    });

    expect(result).toMatchObject({ status: 'matched', identity_confidence: 'provisional' });
    expect(harness.emit).toHaveBeenCalledWith(
      expect.objectContaining({ confidence: 'provisional', person_id: 'ann' }),
    );
    expect(harness.utterances.documents[0].person_id).toBeUndefined();
    expect(harness.voiceprints.documents).toHaveLength(1);
  });

  it('refuses to choose between two people who score within the margin', async () => {
    const runnerUp = TRUE_MATCH - ATTRIBUTION_MARGIN / 2;
    expect(runnerUp).toBeGreaterThan(ATTRIBUTION_THRESHOLD);
    const harness = createHarness({
      people: [person('ann', 'Ann'), person('ben', 'Ben')],
      voiceprints: [
        voiceprint('print-ann', 'ann', at(TRUE_MATCH)),
        voiceprint('print-ben', 'ben', at(runnerUp)),
      ],
      utterances: [utterance('utterance-1', 'conversation-1')],
    });

    const result = await harness.service.attributeSpeaker({
      embedding: [1, 0, 0],
      duration_ms: CONFIRMED_SPEECH_MS,
      conversation_id: 'conversation-1',
      utterance_ids: ['utterance-1'],
    });

    expect(result).toEqual({ status: 'pending', reason: 'ambiguous' });
    expect(harness.emit).not.toHaveBeenCalled();
    expect(harness.utterances.documents[0].person_id).toBeUndefined();
  });

  /**
   * Found in the live database: 6 of 11 voiceprints pointed at people who no
   * longer existed. An orphan winning the search used to take attribution down
   * for that speaker for the whole conversation.
   */
  it('ignores voiceprints whose person no longer exists', async () => {
    const harness = createHarness({
      people: [person('ann', 'Ann')],
      voiceprints: [
        voiceprint('print-orphan', 'person-deleted', [1, 0]),
        voiceprint('print-ann', 'ann', at(0.9)),
      ],
      utterances: [utterance('utterance-1', 'conversation-1')],
    });

    const result = await harness.service.attributeSpeaker({
      embedding: [1, 0],
      duration_ms: CONFIRMED_SPEECH_MS,
      conversation_id: 'conversation-1',
      utterance_ids: ['utterance-1'],
    });

    expect(result).toMatchObject({ status: 'matched', person_id: 'ann' });
  });

  it('scores a person by their best print rather than their average one', async () => {
    const harness = createHarness({
      people: [person('ann', 'Ann'), person('ben', 'Ben')],
      voiceprints: [
        voiceprint('ann-dorm', 'ann', at(0.05)),
        voiceprint('ann-hall', 'ann', at(TRUE_MATCH)),
        voiceprint('ben-1', 'ben', at(TRUE_MATCH - 2 * ATTRIBUTION_MARGIN)),
        voiceprint('ben-2', 'ben', at(TRUE_MATCH - 2 * ATTRIBUTION_MARGIN)),
      ],
      utterances: [utterance('utterance-1', 'conversation-1')],
    });

    const result = await harness.service.attributeSpeaker({
      embedding: [1, 0, 0],
      duration_ms: CONFIRMED_SPEECH_MS,
      conversation_id: 'conversation-1',
      utterance_ids: ['utterance-1'],
    });

    expect(result).toMatchObject({ status: 'matched', person_id: 'ann' });
  });
});

describe('unknown voices', () => {
  it('does not mint a person for a stranger it has barely heard', async () => {
    const harness = createHarness({
      utterances: [utterance('utterance-1', 'conversation-1')],
    });

    const result = await harness.service.attributeSpeaker({
      embedding: [0, 1],
      duration_ms: CONFIRMED_SPEECH_MS - 1,
      conversation_id: 'conversation-1',
      utterance_ids: ['utterance-1'],
    });

    expect(result).toEqual({ status: 'pending', reason: 'no_match' });
    expect(harness.people.documents).toEqual([]);
    expect(harness.voiceprints.documents).toEqual([]);
  });

  it('creates an unnamed person once there is enough speech to recognise them again', async () => {
    const harness = createHarness({
      utterances: [utterance('utterance-1', 'conversation-1')],
    });

    const result = await harness.service.attributeSpeaker({
      embedding: [0, 1, 0],
      session_mean: [0, 0, 1],
      duration_ms: CONFIRMED_SPEECH_MS,
      conversation_id: 'conversation-1',
      utterance_ids: ['utterance-1'],
    });

    expect(result).toMatchObject({ status: 'created', identity_confidence: 'confirmed' });
    expect(harness.people.documents).toHaveLength(1);
    expect(harness.people.documents[0].name).toBe(UNNAMED_PERSON_NAME);
    expect(harness.voiceprints.documents[0]).toMatchObject({
      embedding: [0, 1, 0],
      session_mean: [0, 0, 1],
      duration_ms: CONFIRMED_SPEECH_MS,
    });
    expect(harness.emit).toHaveBeenCalledWith(
      expect.objectContaining({ name: UNNAMED_PERSON_NAME, confidence: 'confirmed' }),
    );
  });

  /**
   * The regression that broke the acceptance test, at the level the user feels
   * it. Two people are enrolled from one session; a third voice appears who was
   * never enrolled. Centering the comparison made those two prints
   * near-antipodal and every voice scored ~0.5 as one of them, so the stranger
   * was confidently handed a friend's name — and every fact and promise he
   * stated would have been filed under that friend. He must become his own
   * unnamed voice instead.
   */
  it('refuses a stranger in a room where two people are enrolled', async () => {
    const sessionMean = [1 / Math.SQRT2, 0, 0];
    const harness = createHarness({
      people: [person('ann', 'Ann'), person('ben', 'Ben')],
      voiceprints: [
        voiceprint('print-ann', 'ann', [1 / Math.SQRT2, 1 / Math.SQRT2, 0], { session_mean: sessionMean }),
        voiceprint('print-ben', 'ben', [1 / Math.SQRT2, -1 / Math.SQRT2, 0], { session_mean: sessionMean }),
      ],
      utterances: [utterance('utterance-1', 'conversation-1')],
    });

    const result = await harness.service.attributeSpeaker({
      embedding: [0.4, 0.45, 0.7984],
      session_mean: sessionMean,
      duration_ms: CONFIRMED_SPEECH_MS,
      conversation_id: 'conversation-1',
      utterance_ids: ['utterance-1'],
    });

    expect(result.status).toBe('created');
    const personId = (result as { person_id: string }).person_id;
    expect(['ann', 'ben']).not.toContain(personId);
    expect(harness.utterances.documents[0].person_id).toBe(personId);
    expect(harness.emit).toHaveBeenCalledWith(
      expect.objectContaining({ name: UNNAMED_PERSON_NAME }),
    );
  });

  it('stays silent about a stranger it has not heard enough of, whoever is enrolled', async () => {
    const harness = createHarness({
      people: [person('ann', 'Ann'), person('ben', 'Ben')],
      voiceprints: [
        voiceprint('print-ann', 'ann', at(NEAREST_IMPOSTOR)),
        voiceprint('print-ben', 'ben', at(0.3)),
      ],
      utterances: [utterance('utterance-1', 'conversation-1')],
    });

    const result = await harness.service.attributeSpeaker({
      embedding: [1, 0, 0],
      duration_ms: CONFIRMED_SPEECH_MS - 1,
      conversation_id: 'conversation-1',
      utterance_ids: ['utterance-1'],
    });

    expect(result).toEqual({ status: 'pending', reason: 'no_match' });
    expect(harness.people.documents.map((record) => record._id)).toEqual(['ann', 'ben']);
    expect(harness.emit).not.toHaveBeenCalled();
  });
});

describe('one person per session cluster', () => {
  /**
   * Two clusters in one room are two people by construction. The second one
   * becomes an unnamed voice rather than a second helping of Ann.
   */
  it('will not hand the same person to two clusters of one conversation', async () => {
    const harness = createHarness({
      people: [person('ann', 'Ann')],
      voiceprints: [voiceprint('print-ann', 'ann', [1, 0])],
      utterances: [utterance('utterance-1', 'conversation-1'), utterance('utterance-2', 'conversation-1')],
    });

    const first = await harness.service.attributeSpeaker({
      embedding: [1, 0],
      duration_ms: CONFIRMED_SPEECH_MS,
      conversation_id: 'conversation-1',
      utterance_ids: ['utterance-1'],
    });
    const second = await harness.service.attributeSpeaker({
      embedding: at(0.95),
      duration_ms: CONFIRMED_SPEECH_MS,
      conversation_id: 'conversation-1',
      utterance_ids: ['utterance-2'],
    });

    expect(first).toMatchObject({ status: 'matched', person_id: 'ann' });
    expect(second.status).toBe('created');
    expect((second as { person_id: string }).person_id).not.toBe('ann');
  });

  it('lets a cluster re-attribute itself as it accumulates speech', async () => {
    const harness = createHarness({
      people: [person('ann', 'Ann')],
      voiceprints: [voiceprint('print-ann', 'ann', [1, 0])],
      utterances: [utterance('utterance-1', 'conversation-1'), utterance('utterance-2', 'conversation-1')],
    });

    await harness.service.attributeSpeaker({
      embedding: [1, 0],
      duration_ms: PROVISIONAL_SPEECH_MS,
      conversation_id: 'conversation-1',
      utterance_ids: ['utterance-1'],
    });
    const later = await harness.service.attributeSpeaker({
      embedding: [1, 0],
      duration_ms: CONFIRMED_SPEECH_MS,
      conversation_id: 'conversation-1',
      utterance_ids: ['utterance-1', 'utterance-2'],
    });

    expect(later).toMatchObject({ status: 'matched', person_id: 'ann', identity_confidence: 'confirmed' });
  });

  it('assigns a whole session at once, one person per cluster', async () => {
    const harness = createHarness({
      people: [person('ann', 'Ann'), person('ben', 'Ben')],
      voiceprints: [voiceprint('print-ann', 'ann', [1, 0]), voiceprint('print-ben', 'ben', [0, 1])],
      utterances: [utterance('utterance-1', 'conversation-1'), utterance('utterance-2', 'conversation-1')],
    });

    const results = await harness.service.attributeSession({
      conversation_id: 'conversation-1',
      clusters: [
        {
          session_speaker: 'cluster-0',
          embedding: [0.95, 0.31],
          duration_ms: CONFIRMED_SPEECH_MS,
          utterance_ids: ['utterance-1'],
        },
        {
          session_speaker: 'cluster-1',
          embedding: [0.31, 0.95],
          duration_ms: CONFIRMED_SPEECH_MS,
          utterance_ids: ['utterance-2'],
        },
      ],
    });

    expect(results['cluster-0']).toMatchObject({ status: 'matched', person_id: 'ann' });
    expect(results['cluster-1']).toMatchObject({ status: 'matched', person_id: 'ben' });
  });
});

describe('naming', () => {
  /**
   * The whole product in one test: a stranger in a dorm becomes a name, and a
   * week later, in a different room on a different channel, the name comes
   * back. The two pooled embeddings sit at 0.746 — the tightest true match
   * measured in the real fixture, so this is the hardest version of the case,
   * not a flattering one. The session means differ wildly between the two
   * rooms and are stored on both prints; they no longer affect the gate.
   */
  it('recognises a named voice in a different room in a later session', async () => {
    const harness = createHarness({
      utterances: [utterance('utterance-1', 'dorm'), utterance('utterance-2', 'lecture-hall')],
    });

    const created = await harness.service.attributeSpeaker({
      embedding: at(TRUE_MATCH),
      session_mean: [0, 0, 3],
      duration_ms: CONFIRMED_SPEECH_MS,
      conversation_id: 'dorm',
      utterance_ids: ['utterance-1'],
    });
    expect(created.status).toBe('created');
    const personId = (created as { person_id: string }).person_id;

    await harness.service.namePerson(personId, { name: 'Tarun' });

    const recognised = await harness.service.attributeSpeaker({
      embedding: [1, 0, 0],
      session_mean: [0, 4, 0],
      duration_ms: CONFIRMED_SPEECH_MS,
      conversation_id: 'lecture-hall',
      utterance_ids: ['utterance-2'],
    });

    expect(recognised).toMatchObject({ status: 'matched', person_id: personId });
    expect(harness.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation_id: 'lecture-hall',
        name: 'Tarun',
        confidence: 'confirmed',
      }),
    );
  });

  /**
   * The other half of the same story, and the one that goes wrong silently: a
   * different person in that later room must not inherit the name. Their
   * nearest neighbour is the enrolled voice, at the score a real stranger
   * managed in the fixture.
   */
  it('does not hand a stranger the name of the person enrolled beside them', async () => {
    const harness = createHarness({
      utterances: [utterance('utterance-1', 'lecture-hall')],
      people: [person('tarun', 'Tarun')],
      voiceprints: [voiceprint('print-tarun', 'tarun', at(NEAREST_IMPOSTOR), { enrolled: true })],
    });

    const result = await harness.service.attributeSpeaker({
      embedding: [1, 0, 0],
      duration_ms: CONFIRMED_SPEECH_MS,
      conversation_id: 'lecture-hall',
      utterance_ids: ['utterance-1'],
    });

    expect(result.status).toBe('created');
    expect((result as { person_id: string }).person_id).not.toBe('tarun');
    expect(harness.emit).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'Tarun' }));
  });

  it('stores the pooled speech behind a name as a permanent print', async () => {
    const harness = createHarness({ people: [person('ann', UNNAMED_PERSON_NAME)] });

    await harness.service.namePerson(
      'ann',
      { name: 'Ann', relationship: 'Floormate' },
      {
        embedding: [1, 0, 3],
        session_mean: [0, 0, 3],
        duration_ms: 24_000,
        conversation_id: 'dorm',
        utterance_id: 'utterance-1',
      },
    );

    expect(harness.people.documents[0]).toMatchObject({
      name: 'Ann',
      relationship: 'Floormate',
      updated_at: NOW,
    });
    expect(harness.voiceprints.documents).toHaveLength(1);
    expect(harness.voiceprints.documents[0]).toMatchObject({
      person_id: 'ann',
      embedding: [1, 0, 3],
      session_mean: [0, 0, 3],
      source_conversation_id: 'dorm',
      source_utterance_id: 'utterance-1',
      enrolled: true,
    });
  });

  it('renames a person and re-emits their conversations as confirmed', async () => {
    const harness = createHarness({
      people: [person('unknown-1', UNNAMED_PERSON_NAME)],
      voiceprints: [voiceprint('print-1', 'unknown-1', [1, 0])],
      utterances: [
        utterance('utterance-1', 'conversation-a', { person_id: 'unknown-1' }),
        utterance('utterance-2', 'conversation-b', { person_id: 'unknown-1' }),
      ],
    });

    const named = await harness.service.namePerson('unknown-1', { name: 'Jordan' });

    expect(named.name).toBe('Jordan');
    expect(harness.emit).toHaveBeenCalledWith({
      type: 'identity',
      conversation_id: 'conversation-a',
      person_id: 'unknown-1',
      name: 'Jordan',
      utterance_ids: ['utterance-1'],
      confidence: 'confirmed',
    });
    expect(harness.emit).toHaveBeenCalledTimes(2);
  });

  it('leaves automatically captured prints evictable after naming', async () => {
    // Naming used to retroactively mark every existing print `enrolled`, and
    // enrolled prints are never evicted. A named person therefore pinned itself
    // at MAX_VOICEPRINTS_PER_PERSON forever, and each later session inserted a
    // print that the next eviction immediately deleted — so somebody first met
    // in one room could never learn how they sound in another. Putting a name
    // to a voice says nothing about whether the audio behind those prints was
    // hand-checked.
    const harness = createHarness({
      people: [person('unknown-1', UNNAMED_PERSON_NAME)],
      voiceprints: [voiceprint('print-1', 'unknown-1', [1, 0])],
    });

    await harness.service.namePerson('unknown-1', { name: 'Jordan' });

    expect(harness.voiceprints.documents[0].enrolled).toBeFalsy();
  });

  it('enrolls the pooled speech the user named the voice with', async () => {
    // This print is the one a human really did create, so it is the one that
    // must survive eviction.
    const harness = createHarness({
      people: [person('unknown-1', UNNAMED_PERSON_NAME)],
      voiceprints: [voiceprint('print-1', 'unknown-1', [1, 0])],
    });

    await harness.service.namePerson(
      'unknown-1',
      { name: 'Jordan' },
      { embedding: [0, 1], duration_ms: CONFIRMED_SPEECH_MS },
    );

    const enrolled = harness.voiceprints.documents.filter((print) => print.enrolled);
    expect(enrolled).toHaveLength(1);
    expect(enrolled[0].duration_ms).toBe(CONFIRMED_SPEECH_MS);
  });

  it('rejects naming somebody who does not exist', async () => {
    const harness = createHarness();
    await expect(harness.service.namePerson('nobody', { name: 'Ann' })).rejects.toThrow('Unknown person');
  });
});

describe('voiceprint accumulation', () => {
  /**
   * A print backed by thin pooled speech recognises a thin cluster in another
   * room only two thirds of the time, and each miss mints a duplicate. Ann is
   * already recognisable, so this session adds nothing worth the slot.
   */
  it('declines to store a print for pooled speech too thin to survive a change of room', async () => {
    const harness = createHarness({
      people: [person('ann', 'Ann')],
      voiceprints: [voiceprint('print-ann', 'ann', [1, 0])],
      utterances: [utterance('utterance-1', 'conversation-1')],
    });

    const result = await harness.service.attributeSpeaker({
      embedding: [1, 0],
      duration_ms: CROSS_SESSION_SPEECH_MS - 1,
      conversation_id: 'conversation-1',
      utterance_ids: ['utterance-1'],
    });

    expect(result).toMatchObject({ status: 'matched', person_id: 'ann' });
    expect(harness.voiceprints.documents).toHaveLength(1);
    // The utterance still files under the print that matched, so nothing
    // downstream is left without a voiceprint_id.
    expect(harness.utterances.documents[0]).toMatchObject({ voiceprint_id: 'print-ann' });
  });

  /**
   * The exception that keeps the floor from being the mint floor in disguise.
   * Somebody met for thirty seconds has no print at all, and no print misses
   * 100% of the time — strictly worse than a thin one, which still recognises a
   * long cluster next time with 1.7% miss.
   */
  it('always stores a first print, however thin, for somebody it has just met', async () => {
    const harness = createHarness({
      people: [],
      voiceprints: [],
      utterances: [utterance('utterance-1', 'conversation-1')],
    });

    const result = await harness.service.attributeSpeaker({
      embedding: [1, 0],
      duration_ms: CROSS_SESSION_SPEECH_MS - 1,
      conversation_id: 'conversation-1',
      utterance_ids: ['utterance-1'],
    });

    expect(result.status).toBe('created');
    expect(harness.voiceprints.documents).toHaveLength(1);
    if (result.status !== 'created') return;
    expect(harness.utterances.documents[0]).toMatchObject({
      voiceprint_id: result.voiceprint_id,
    });
  });

  /**
   * The print dropped at the cap is the one backed by the least speech, not the
   * one captured longest ago. Evicting by age discards a person's best evidence
   * first and costs about seventeen points of recall — see selectEvictions.
   */
  it('keeps a bounded number of prints, evicting the one with the least speech behind it', async () => {
    const automatic = Array.from({ length: MAX_VOICEPRINTS_PER_PERSON - 1 }, (_, index) =>
      voiceprint(`auto-${index}`, 'ann', [1, 0], {
        // Newest is the thinnest, so age and evidence disagree about who goes.
        created_at: `2026-02-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
        duration_ms: 300_000 - index * 1_000,
      }),
    );
    const thinnest = `auto-${MAX_VOICEPRINTS_PER_PERSON - 2}`;
    const harness = createHarness({
      people: [person('ann', 'Ann')],
      voiceprints: [
        voiceprint('enrolled-oldest', 'ann', [1, 0], { created_at: AT, enrolled: true }),
        ...automatic,
      ],
      utterances: [utterance('utterance-1', 'conversation-1')],
    });

    await harness.service.attributeSpeaker({
      embedding: [1, 0],
      duration_ms: CROSS_SESSION_SPEECH_MS,
      conversation_id: 'conversation-1',
      utterance_ids: ['utterance-1'],
    });

    const ids = harness.voiceprints.documents.map((print) => print._id);
    expect(ids).toHaveLength(MAX_VOICEPRINTS_PER_PERSON);
    expect(ids).toContain('enrolled-oldest');
    expect(ids).toContain('auto-0');
    expect(ids).not.toContain(thinnest);
  });

  /**
   * Storing a print must not delete it again on the way out. Everything Ann
   * already has holds more speech than this session did, so the thinnest print
   * in the set is the new one, and it is the id the caller was just handed.
   */
  it('never evicts the print it has just stored', async () => {
    const automatic = Array.from({ length: MAX_VOICEPRINTS_PER_PERSON - 1 }, (_, index) =>
      voiceprint(`auto-${index}`, 'ann', [1, 0], { duration_ms: 600_000 }),
    );
    const harness = createHarness({
      people: [person('ann', 'Ann')],
      voiceprints: [
        voiceprint('enrolled-oldest', 'ann', [1, 0], { created_at: AT, enrolled: true }),
        ...automatic,
      ],
      utterances: [utterance('utterance-1', 'conversation-1')],
    });

    const result = await harness.service.attributeSpeaker({
      embedding: [1, 0],
      duration_ms: CROSS_SESSION_SPEECH_MS,
      conversation_id: 'conversation-1',
      utterance_ids: ['utterance-1'],
    });

    const ids = harness.voiceprints.documents.map((print) => print._id);
    expect(ids).toHaveLength(MAX_VOICEPRINTS_PER_PERSON);
    expect(result.status).toBe('matched');
    if (result.status !== 'matched') return;
    expect(ids).toContain(result.voiceprint_id);
    expect(harness.utterances.documents[0]).toMatchObject({
      voiceprint_id: result.voiceprint_id,
    });
  });
});

describe('owner authorization', () => {
  it('authorizes the owner at the owner threshold and refuses just below it', async () => {
    const harness = createHarness({
      people: [person('owner-person', 'Owner', { is_owner: true })],
      voiceprints: [voiceprint('owner-print', 'owner-person', [1, 0, 0])],
    });

    await expect(harness.service.isOwnerVoice(at(OWNER_AUTH_THRESHOLD))).resolves.toMatchObject({
      authorized: true,
    });
    await expect(
      harness.service.isOwnerVoice(at(OWNER_AUTH_THRESHOLD - 0.01)),
    ).resolves.toMatchObject({ authorized: false });
  });

  /** The owner's bar is the strictest one in the system, and above a stranger's reach. */
  it('holds the owner to a stricter bar than ordinary attribution', async () => {
    const harness = createHarness({
      people: [person('owner-person', 'Owner', { is_owner: true })],
      voiceprints: [voiceprint('owner-print', 'owner-person', [1, 0, 0])],
    });

    expect(OWNER_AUTH_THRESHOLD).toBeGreaterThanOrEqual(ATTRIBUTION_THRESHOLD);
    await expect(harness.service.isOwnerVoice(at(ATTRIBUTION_THRESHOLD))).resolves.toMatchObject({
      authorized: false,
    });
    await expect(harness.service.isOwnerVoice(at(NEAREST_IMPOSTOR))).resolves.toMatchObject({
      authorized: false,
    });
  });

  /** Amelia acts on the owner's voice, so a near-tie is a refusal. */
  it('refuses the owner when somebody else scores within the margin', async () => {
    const harness = createHarness({
      people: [person('owner-person', 'Owner', { is_owner: true }), person('ben', 'Ben')],
      voiceprints: [
        voiceprint('owner-print', 'owner-person', [1, 0]),
        voiceprint('ben-print', 'ben', at(0.99)),
      ],
    });

    await expect(harness.service.isOwnerVoice([1, 0])).resolves.toMatchObject({ authorized: false });
  });

  it('rejects owner authorization when no owner is enrolled', async () => {
    const harness = createHarness();

    await expect(harness.service.isOwnerVoice([1, 0])).resolves.toEqual({
      authorized: false,
      confidence: 0,
    });
  });

  /**
   * Amelia acts on what she hears here, so the one thing this must never do is
   * authorize a voice that merely happens to be the closest one on file.
   */
  it('refuses a stranger even when the owner is the only person enrolled', async () => {
    const harness = createHarness({
      people: [person('owner-person', 'Owner', { is_owner: true })],
      voiceprints: [voiceprint('owner-print', 'owner-person', at(NEAREST_IMPOSTOR))],
    });

    const result = await harness.service.isOwnerVoice([1, 0, 0]);
    expect(result.authorized).toBe(false);
    expect(result.confidence).toBeCloseTo(NEAREST_IMPOSTOR, 6);
  });

  it('scores the owner on raw embeddings, unmoved by session means', async () => {
    const harness = createHarness({
      people: [person('owner-person', 'Owner', { is_owner: true })],
      voiceprints: [
        voiceprint('owner-print', 'owner-person', [1, 0, 0], { session_mean: [0, 0, 3] }),
      ],
    });

    const withoutMean = await harness.service.isOwnerVoice([1, 0, 0]);
    const withMean = await harness.service.isOwnerVoice([1, 0, 0], [0, 4, 0]);

    expect(withoutMean).toEqual({ authorized: true, confidence: 1 });
    expect(withMean).toEqual(withoutMean);
  });
});

describe('enrollment', () => {
  it('rejects enrollment embeddings with the wrong dimensions', async () => {
    const harness = createHarness();

    await expect(
      harness.service.enroll({
        name: 'Taylor',
        duration_ms: 4_000,
        embedding: Array(VOICEPRINT_DIMS - 1).fill(0),
      }),
    ).rejects.toThrow('192 dimensions');
    expect(harness.people.documents).toEqual([]);
    expect(harness.voiceprints.documents).toEqual([]);
  });

  it('reuses an enrolled person, keeps the session mean, and omits the embedding', async () => {
    const harness = createHarness({ people: [person('person-enrolled', 'Taylor')] });
    const embedding = Array(VOICEPRINT_DIMS).fill(0.1);
    const sessionMean = Array(VOICEPRINT_DIMS).fill(0.01);

    const result = await harness.service.enroll({
      person_id: 'person-enrolled',
      utterance_id: 'utterance-source',
      duration_ms: 4_000,
      embedding,
      session_mean: sessionMean,
    });

    expect(result.person._id).toBe('person-enrolled');
    expect(result.voiceprint).not.toHaveProperty('embedding');
    expect(result.voiceprint).toMatchObject({
      person_id: 'person-enrolled',
      source_utterance_id: 'utterance-source',
      created_at: NOW,
    });
    expect(harness.voiceprints.documents[0]).toMatchObject({
      embedding,
      session_mean: sessionMean,
      enrolled: true,
    });
  });

  it('refuses to enroll against a person who does not exist', async () => {
    const harness = createHarness();
    await expect(
      harness.service.enroll({
        person_id: 'nobody',
        duration_ms: 4_000,
        embedding: Array(VOICEPRINT_DIMS).fill(0.1),
      }),
    ).rejects.toThrow('Unknown person');
  });
});

describe('merging', () => {
  it('merges into the oldest person and preserves every voiceprint', async () => {
    const harness = createHarness({
      people: [
        person('person-newer', 'Newer record', { created_at: '2026-01-02T00:00:00.000Z' }),
        person('person-oldest', 'Oldest record', { created_at: '2026-01-01T00:00:00.000Z' }),
        person('person-newest', 'Newest record', { created_at: '2026-01-03T00:00:00.000Z' }),
      ],
      voiceprints: [
        voiceprint('voiceprint-oldest', 'person-oldest', [1, 0]),
        voiceprint('voiceprint-newer', 'person-newer', [0, 1]),
        voiceprint('voiceprint-newest', 'person-newest', [-1, 0]),
      ],
      utterances: [
        utterance('utterance-1', 'conversation-1', { person_id: 'person-newer' }),
        utterance('utterance-2', 'conversation-2', { person_id: 'person-newest' }),
      ],
      facts: [
        {
          _id: 'fact-1',
          owner_id: OWNER_ID,
          person_id: 'person-newer',
          attribute: 'workplace',
          claim: 'Works at Amelia',
          claim_normalized: 'works at amelia',
          primary_source_utterance_id: 'utterance-1',
          valid_from: AT,
          created_at: AT,
        },
      ],
      promises: [
        {
          _id: 'promise-1',
          owner_id: OWNER_ID,
          person_id: 'person-newest',
          source_utterance_id: 'utterance-2',
          text: 'Will follow up',
          text_normalized: 'will follow up',
          status: 'open',
          created_at: AT,
        },
      ],
    });

    const survivor = await harness.service.mergePeople({
      person_ids: ['person-newer', 'person-oldest', 'person-newest'],
    });

    expect(survivor._id).toBe('person-oldest');
    expect(harness.people.documents.map((record) => record._id)).toEqual(['person-oldest']);
    expect(harness.voiceprints.documents).toHaveLength(3);
    expect(
      harness.voiceprints.documents.every((print) => print.person_id === 'person-oldest'),
    ).toBe(true);
    expect(harness.facts.documents[0].person_id).toBe('person-oldest');
    expect(harness.promises.documents[0].person_id).toBe('person-oldest');
    expect(harness.emit).toHaveBeenCalledTimes(2);
    expect(harness.emit).toHaveBeenCalledWith({
      type: 'identity',
      conversation_id: 'conversation-1',
      person_id: 'person-oldest',
      name: 'Oldest record',
      utterance_ids: ['utterance-1'],
      confidence: 'confirmed',
    });
  });

  it('refuses a merge of fewer than two people', async () => {
    const harness = createHarness({ people: [person('ann', 'Ann')] });
    await expect(harness.service.mergePeople({ person_ids: ['ann', 'ann'] })).rejects.toThrow(
      'At least two people',
    );
  });
});
