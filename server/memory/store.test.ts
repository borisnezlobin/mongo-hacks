import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation, Fact, Person, PromiseMemory, Reminder, Utterance } from '../../shared/contracts';
import { OWNER_ID } from '../../shared/contracts';
import { AmeliaBus } from '../lib/bus';
import { closeStorage, createLocalDriver, useStorage, type LocalDriver } from '../storage';

const embeddings = vi.hoisted(() => ({ embedDocuments: vi.fn(), embedQuery: vi.fn() }));
vi.mock('./embeddings', () => embeddings);

import { collections } from './db';
import {
  backfillFactEmbeddings,
  deleteConversation,
  listDueReminders,
  markReminderSent,
  mergePeople,
  recordFact,
  searchFactsByEmbedding,
  searchFactsByKeyword,
  upsertUtterance,
} from './store';

let dataDir: string;
let driver: LocalDriver;
let bus: AmeliaBus;

const person = (id: string, name: string, createdAt: string): Person => ({
  _id: id, owner_id: OWNER_ID, name, created_at: createdAt, updated_at: createdAt,
});

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'amelia-store-test-'));
  driver = await createLocalDriver({ dataDir, fsync: false });
  useStorage(driver);
  bus = new AmeliaBus();
  embeddings.embedDocuments.mockReset();
  embeddings.embedDocuments.mockImplementation(async (texts: string[]) => texts.map(() => [1, 0, 0]));
});

afterEach(async () => {
  await closeStorage();
  await rm(dataDir, { recursive: true, force: true });
});

describe('a fact whose embedding never arrived', () => {
  it('is still stored, marked, and reported instead of silently vanishing', async () => {
    embeddings.embedDocuments.mockRejectedValue(new Error('Fireworks embedding failed: 503'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const fact = await recordFact(bus, {
      person_id: 'p-maya', attribute: 'move', claim: 'Maya moves in September',
      primary_source_utterance_id: 'u1',
    });

    expect(fact.embedding).toBeUndefined();
    expect(errors).toHaveBeenCalled();
    const stored = await collections.facts().findOne({ _id: fact._id });
    expect(stored).toMatchObject({ embedding_error: expect.stringContaining('503') });
    errors.mockRestore();
  });

  it('is repaired by a backfill once the provider is back', async () => {
    embeddings.embedDocuments.mockRejectedValue(new Error('down'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fact = await recordFact(bus, {
      person_id: 'p-maya', attribute: 'move', claim: 'Maya moves in September',
      primary_source_utterance_id: 'u1',
    });

    embeddings.embedDocuments.mockImplementation(async (texts: string[]) => texts.map(() => [0, 1, 0]));
    expect(await backfillFactEmbeddings()).toEqual({ pending: 1, embedded: 1, failed: 0 });

    const repaired = await collections.facts().findOne({ _id: fact._id });
    expect(repaired?.embedding).toEqual([0, 1, 0]);
    expect(repaired).not.toHaveProperty('embedding_error');
    expect(repaired).not.toHaveProperty('embedding_pending_since');
  });

  it('leaves an already-embedded fact alone', async () => {
    await recordFact(bus, { person_id: 'p1', attribute: 'a', claim: 'x', primary_source_utterance_id: 'u1' });
    expect(await backfillFactEmbeddings()).toEqual({ pending: 0, embedded: 0, failed: 0 });
  });
});

describe('fact search without Atlas', () => {
  beforeEach(async () => {
    embeddings.embedDocuments.mockImplementation(async () => [[1, 0, 0]]);
    await recordFact(bus, { person_id: 'p1', attribute: 'move', claim: 'Maya moves in September', primary_source_utterance_id: 'u1' });
    embeddings.embedDocuments.mockImplementation(async () => [[0, 1, 0]]);
    await recordFact(bus, { person_id: 'p2', attribute: 'food', claim: 'Jules likes Ethiopian food', primary_source_utterance_id: 'u2' });
  });

  it('ranks by exact cosine', async () => {
    const [best] = await searchFactsByEmbedding([1, 0, 0]);
    expect(best.fact.claim).toContain('September');
    expect(best.score).toBeCloseTo(1);
  });

  it('honours a person filter', async () => {
    const results = await searchFactsByEmbedding([1, 0, 0], 'p2');
    expect(results.map((result) => result.fact.person_id)).toEqual(['p2']);
  });

  it('excludes superseded facts, which must never reach an answer', async () => {
    const [live] = await collections.facts().find({ person_id: 'p1' }).toArray();
    await collections.facts().updateOne({ _id: live._id }, { $set: { superseded_by: 'other' } });
    expect(await searchFactsByEmbedding([1, 0, 0])).toHaveLength(1);
  });

  it('matches lexically too, for queries a vector misses', async () => {
    const [best] = await searchFactsByKeyword('ethiopian food');
    expect(best.fact.claim).toContain('Ethiopian');
  });
});

describe('conversation participants', () => {
  it('are recorded as attribution resolves, not left as an empty list', async () => {
    await upsertUtterance({ _id: 'u1', owner_id: OWNER_ID, conversation_id: 'c1', person_id: 'p-maya', text: 'hi', start_ms: 0, end_ms: 1, is_final: true });
    await upsertUtterance({ _id: 'u2', owner_id: OWNER_ID, conversation_id: 'c1', person_id: 'p-jules', text: 'hey', start_ms: 1, end_ms: 2, is_final: true });
    await upsertUtterance({ _id: 'u3', owner_id: OWNER_ID, conversation_id: 'c1', person_id: 'p-maya', text: 'again', start_ms: 2, end_ms: 3, is_final: true });

    const conversation = await collections.conversations().findOne({ _id: 'c1' });
    expect(conversation?.participant_ids).toEqual(['p-maya', 'p-jules']);
  });

  it('are left untouched by an unattributed utterance', async () => {
    await upsertUtterance({ _id: 'u1', owner_id: OWNER_ID, conversation_id: 'c1', text: 'who said that', start_ms: 0, end_ms: 1, is_final: true });
    expect(await collections.conversations().findOne({ _id: 'c1' })).toBeNull();
  });
});

describe('merging two people', () => {
  beforeEach(async () => {
    await collections.people().insertOne(person('p-old', '', '2026-01-01T00:00:00Z'));
    await collections.people().insertOne(person('p-new', 'Maya', '2026-02-01T00:00:00Z'));
    await collections.utterances().insertOne({ _id: 'u1', owner_id: OWNER_ID, conversation_id: 'c1', person_id: 'p-new', text: 'hi', start_ms: 0, end_ms: 1, is_final: true, created_at: 'x', updated_at: 'x' } as Utterance);
    await collections.conversations().insertOne({ _id: 'c1', owner_id: OWNER_ID, started_at: 'x', participant_ids: ['p-new', 'p-other'] } as Conversation);
  });

  it('keeps the oldest person and carries the name across', async () => {
    const merged = await mergePeople(bus, ['p-old', 'p-new']);
    expect(merged._id).toBe('p-old');
    expect(merged.name).toBe('Maya');
    expect(await collections.people().findOne({ _id: 'p-new' })).toBeNull();
  });

  it('re-points conversation participants, which used to go permanently stale', async () => {
    await mergePeople(bus, ['p-old', 'p-new']);
    const conversation = await collections.conversations().findOne({ _id: 'c1' });
    expect(conversation?.participant_ids).toEqual(['p-old', 'p-other']);
  });

  it('leaves no row pointing at a deleted person', async () => {
    await mergePeople(bus, ['p-old', 'p-new']);
    expect(await collections.utterances().countDocuments({ person_id: 'p-new' })).toBe(0);
    expect(await collections.utterances().countDocuments({ person_id: 'p-old' })).toBe(1);
  });

  it('changes nothing at all when the merge cannot proceed', async () => {
    await expect(mergePeople(bus, ['p-old'])).rejects.toThrow('at least two');
    expect(await collections.people().countDocuments({})).toBe(2);
  });
});

describe('deleting a conversation', () => {
  beforeEach(async () => {
    await collections.conversations().insertOne({ _id: 'c1', owner_id: OWNER_ID, started_at: 'x', participant_ids: [] } as Conversation);
    await collections.utterances().insertOne({ _id: 'u1', owner_id: OWNER_ID, conversation_id: 'c1', person_id: 'p1', text: 'moves in October', start_ms: 0, end_ms: 1, is_final: true, created_at: 'x', updated_at: 'x' } as Utterance);
    // The old claim lives in another conversation and points at the new one.
    await collections.facts().insertOne({ _id: 'f-old', owner_id: OWNER_ID, person_id: 'p1', attribute: 'move', claim: 'September', claim_normalized: 'september', primary_source_utterance_id: 'u-elsewhere', valid_from: 'a', created_at: 'a', superseded_by: 'f-new' } as Fact);
    await collections.facts().insertOne({ _id: 'f-new', owner_id: OWNER_ID, person_id: 'p1', attribute: 'move', claim: 'October', claim_normalized: 'october', primary_source_utterance_id: 'u1', valid_from: 'b', created_at: 'b' } as Fact);
    await collections.promises().insertOne({ _id: 'pr1', owner_id: OWNER_ID, person_id: 'p1', source_utterance_id: 'u1', text: 'help pack', text_normalized: 'help pack', status: 'open', created_at: 'b' } as PromiseMemory);
    await collections.reminders().insertOne({ _id: 'r1', owner_id: OWNER_ID, promise_id: 'pr1', fire_at: 'b', status: 'scheduled', created_at: 'b' } as Reminder);
  });

  it('takes the derived rows with it', async () => {
    expect(await deleteConversation('c1')).toEqual({ utterances: 1, facts: 1, promises: 1, reminders: 1 });
  });

  it('does not leave a fact pointing at a fact that no longer exists', async () => {
    await deleteConversation('c1');
    const survivor = await collections.facts().findOne({ _id: 'f-old' });
    expect(survivor).not.toBeNull();
    expect(survivor).not.toHaveProperty('superseded_by');
    expect(survivor).not.toHaveProperty('superseded_at');
  });

  it('deletes reminders whose promise is gone', async () => {
    await deleteConversation('c1');
    expect(await collections.reminders().countDocuments({})).toBe(0);
  });

  it('leaves the store consistent across a restart', async () => {
    await deleteConversation('c1');
    await driver.close();
    const reopened = await createLocalDriver({ dataDir, fsync: false });
    useStorage(reopened);
    expect(await collections.facts().findOne({ _id: 'f-old' })).not.toHaveProperty('superseded_by');
    expect(await collections.conversations().countDocuments({})).toBe(0);
    driver = reopened;
  });
});

describe('reminders', () => {
  it('can finally be read back and marked sent', async () => {
    await collections.reminders().insertOne({ _id: 'r-due', owner_id: OWNER_ID, promise_id: 'pr1', fire_at: '2026-01-01T00:00:00Z', status: 'scheduled', created_at: 'x' } as Reminder);
    await collections.reminders().insertOne({ _id: 'r-later', owner_id: OWNER_ID, promise_id: 'pr2', fire_at: '2027-01-01T00:00:00Z', status: 'scheduled', created_at: 'x' } as Reminder);

    const due = await listDueReminders('2026-06-01T00:00:00Z');
    expect(due.map((reminder) => reminder._id)).toEqual(['r-due']);

    expect((await markReminderSent('r-due'))?.status).toBe('sent');
    expect(await listDueReminders('2026-06-01T00:00:00Z')).toEqual([]);
  });
});

describe('idempotent extraction', () => {
  it('returns the stored fact rather than duplicating it when a pass replays', async () => {
    const first = await recordFact(bus, { person_id: 'p1', attribute: 'move', claim: 'Maya moves', primary_source_utterance_id: 'u1' });
    const replay = await recordFact(bus, { person_id: 'p1', attribute: 'move', claim: 'Maya moves', primary_source_utterance_id: 'u1' });
    expect(replay._id).toBe(first._id);
    expect(await collections.facts().countDocuments({})).toBe(1);
  });
});
