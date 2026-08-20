import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OWNER_ID, type Utterance } from '../../shared/contracts';
import { closeStorage, createLocalDriver, useStorage, type LocalDriver } from '../storage';

const embeddings = vi.hoisted(() => ({ embedDocuments: vi.fn(), embedQuery: vi.fn() }));
vi.mock('../memory/embeddings', () => embeddings);

import { searchMemory, searchMemoryScoped } from './retrieval';
import { collections } from '../memory/db';

let dataDir: string;
let driver: LocalDriver;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'amelia-search-'));
  driver = await createLocalDriver({ dataDir, fsync: false });
  useStorage(driver);
  embeddings.embedQuery.mockResolvedValue([1, 0, 0]);
});

afterEach(async () => {
  await closeStorage();
  await rm(dataDir, { recursive: true, force: true });
});

function utterance(over: Partial<Utterance> & Pick<Utterance, '_id' | 'text'>): Utterance {
  return {
    owner_id: OWNER_ID,
    conversation_id: 'c1',
    start_ms: 0,
    end_ms: 1_000,
    is_final: true,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('finding a turn in a corpus larger than a scan window', () => {
  /**
   * The regression this exists for: retrieval used to rank "the newest 4,000
   * utterances". One 48-minute recording is ~2,770 turns, so by the second day
   * of recording the first day was unreachable regardless of how well it
   * matched. This seeds well past that line and asks about the oldest turn in
   * the corpus.
   */
  beforeEach(async () => {
    await collections.utterances().insertOne(
      utterance({
        _id: 'u-oldest',
        conversation_id: 'c-first',
        person_id: 'p-mert',
        text: 'my flight back to Istanbul leaves from the international terminal',
        created_at: '2026-01-01T00:00:00.000Z',
      }),
    );

    for (let position = 0; position < 6_000; position += 1) {
      await collections.utterances().insertOne(
        utterance({
          _id: `u-filler-${position}`,
          conversation_id: 'c-later',
          person_id: 'p-josh',
          text: 'right yeah I know what you mean about the weather here',
          start_ms: position * 1_000,
          created_at: '2026-02-01T00:00:00.000Z',
        }),
      );
    }
  });

  it('finds the oldest turn in the corpus', async () => {
    const results = await searchMemory('Istanbul terminal');
    expect(results.map((result) => result.id)).toContain('u-oldest');
  }, 60_000);

  it('returns nothing rather than something adjacent when the corpus never covered it', async () => {
    const results = await searchMemory('scuba diving certification');
    expect(results).toEqual([]);
  }, 60_000);
});

describe('scoping a search', () => {
  beforeEach(async () => {
    await collections.utterances().insertOne(
      utterance({ _id: 'u-mert', person_id: 'p-mert', text: 'I am building a freight logistics startup' }),
    );
    await collections.utterances().insertOne(
      utterance({ _id: 'u-josh', person_id: 'p-josh', text: 'a startup in freight sounds brutal honestly' }),
    );
    await collections.utterances().insertOne(
      utterance({ _id: 'u-other', conversation_id: 'c2', person_id: 'p-mert', text: 'the startup pitch went fine' }),
    );
  });

  it('returns what that person said, not what was said back to them', async () => {
    const results = await searchMemoryScoped('startup', { person_id: 'p-mert' });
    expect(results.map((result) => result.id).sort()).toEqual(['u-mert', 'u-other']);
  });

  it('restricts to one conversation when asked', async () => {
    const results = await searchMemoryScoped('startup', { person_id: 'p-mert', conversation_id: 'c2' });
    expect(results.map((result) => result.id)).toEqual(['u-other']);
  });
});

describe('facts a question has nothing to do with', () => {
  beforeEach(async () => {
    for (const [id, claim] of [
      ['f-1', 'Mert is building a freight logistics startup'],
      ['f-2', 'Josh has had a sinus infection for three months'],
      ['f-3', 'Maya moves to Oakland on September 20'],
    ]) {
      await collections.facts().insertOne({
        _id: id,
        owner_id: OWNER_ID,
        person_id: 'p-mert',
        attribute: 'thing',
        claim,
        claim_normalized: claim.toLowerCase(),
        primary_source_utterance_id: `u-${id}`,
        valid_from: 'a',
        created_at: 'a',
        embedding: [0.2, 0.98, 0],
      });
    }
  });

  /**
   * The regression: cosine similarity answers for every stored fact, so before
   * a relevance floor the semantic leg ranked all of them and rank fusion
   * handed back the full fact limit for any question at all. Retrieval could
   * then never report that it had found nothing, which is the signal both the
   * coverage-assembly path and the "nothing in memory" refusal are built on.
   */
  it('reports nothing rather than the nearest few when none of them are close', async () => {
    embeddings.embedQuery.mockResolvedValue([1, 0, 0]);

    expect(await searchMemoryScoped('the price of tin in Bolivia')).toEqual([]);
  });

  it('still returns a fact the question is actually about', async () => {
    embeddings.embedQuery.mockResolvedValue([0.2, 0.98, 0]);

    const ids = (await searchMemoryScoped('freight')).map((result) => result.id);
    expect(ids).toContain('f-1');
  });
});

describe('superseded claims', () => {
  beforeEach(async () => {
    await collections.facts().insertOne({
      _id: 'f-current',
      owner_id: OWNER_ID,
      person_id: 'p-maya',
      attribute: 'move',
      claim: 'Maya moves to Oakland on September 20',
      claim_normalized: 'maya moves to oakland on september 20',
      primary_source_utterance_id: 'u-new',
      valid_from: 'b',
      created_at: 'b',
    });
    await collections.facts().insertOne({
      _id: 'f-old',
      owner_id: OWNER_ID,
      person_id: 'p-maya',
      attribute: 'move',
      claim: 'Maya moves to Oakland on September 1',
      claim_normalized: 'maya moves to oakland on september 1',
      primary_source_utterance_id: 'u-old',
      valid_from: 'a',
      created_at: 'a',
      superseded_by: 'f-current',
    });
    await collections.utterances().insertOne(
      utterance({ _id: 'u-old', person_id: 'p-maya', text: 'I move to Oakland on September 1' }),
    );
    await collections.utterances().insertOne(
      utterance({ _id: 'u-new', person_id: 'p-maya', text: 'the Oakland move slipped to September 20' }),
    );
    await collections.utterances().insertOne(
      utterance({ _id: 'u-colour', person_id: 'p-maya', text: 'Oakland has better weather than the city' }),
    );
  });

  it('never surfaces a superseded claim', async () => {
    const results = await searchMemoryScoped('when is Maya moving to Oakland');
    expect(results.map((result) => result.id)).not.toContain('f-old');
  });

  it('drops the turn a superseded claim came from, and only that turn', async () => {
    const results = await searchMemoryScoped('Oakland');
    const ids = results.map((result) => result.id);

    expect(ids).not.toContain('u-old');
    expect(ids).toContain('u-colour');
  });
});
