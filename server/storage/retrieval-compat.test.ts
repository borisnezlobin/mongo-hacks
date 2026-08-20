/**
 * `server/ask/retrieval.ts` is owned by another lane and still speaks Atlas
 * pipeline. These tests pin the behaviour it gets from the local driver, so the
 * `/ask` path keeps working with no cloud: `$vectorSearch` is answered by exact
 * cosine, and the Atlas-only stages throw the way retrieval's own fallbacks
 * already expect a missing index to.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OWNER_ID } from '../../shared/contracts';
import { closeStorage, createLocalDriver, useStorage, type LocalDriver } from './index';

const embeddings = vi.hoisted(() => ({ embedDocuments: vi.fn(), embedQuery: vi.fn() }));
vi.mock('../memory/embeddings', () => embeddings);

import { searchMemory } from '../ask/retrieval';
import { collections } from '../memory/db';

let dataDir: string;
let driver: LocalDriver;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'amelia-retrieval-'));
  driver = await createLocalDriver({ dataDir, fsync: false });
  useStorage(driver);
  embeddings.embedQuery.mockResolvedValue([1, 0, 0]);

  await collections.facts().insertOne({
    _id: 'f-move', owner_id: OWNER_ID, person_id: 'p-maya', attribute: 'move',
    claim: 'Maya moves to Oakland in September', claim_normalized: 'maya moves to oakland in september',
    primary_source_utterance_id: 'u1', embedding: [1, 0, 0], valid_from: 'a', created_at: 'a',
  });
  await collections.facts().insertOne({
    _id: 'f-old', owner_id: OWNER_ID, person_id: 'p-maya', attribute: 'move',
    claim: 'Maya moves in August', claim_normalized: 'maya moves in august',
    primary_source_utterance_id: 'u0', embedding: [1, 0, 0], valid_from: 'z', created_at: 'z',
    superseded_by: 'f-move',
  });
  await collections.utterances().insertOne({
    _id: 'u1', owner_id: OWNER_ID, conversation_id: 'c1', person_id: 'p-maya',
    text: 'I am moving to Oakland in September', start_ms: 0, end_ms: 1, is_final: true,
    created_at: 'a', updated_at: 'a',
  });
});

afterEach(async () => {
  await closeStorage();
  await rm(dataDir, { recursive: true, force: true });
});

describe('/ask retrieval on local storage', () => {
  it('answers from memory with no Atlas search index in sight', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const results = await searchMemory('where is Maya moving');

    expect(results.length).toBeGreaterThan(0);
    expect(results.some((result) => result.kind === 'fact' && result.id === 'f-move')).toBe(true);
    warn.mockRestore();
  });

  it('never surfaces a superseded claim', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const results = await searchMemory('where is Maya moving');
    expect(results.map((result) => result.id)).not.toContain('f-old');
    warn.mockRestore();
  });

  it('finds the supporting utterance through the inverted index', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const results = await searchMemory('moving Oakland');
    expect(results.some((result) => result.kind === 'utterance' && result.id === 'u1')).toBe(true);
    warn.mockRestore();
  });

  it('rejects the Atlas-only stages loudly rather than returning nothing', async () => {
    await expect(collections.facts().aggregate([{ $rankFusion: {} }]).toArray()).rejects.toThrow(/unsupported/i);
    await expect(collections.facts().aggregate([{ $search: {} }]).toArray()).rejects.toThrow(/unsupported/i);
  });
});
