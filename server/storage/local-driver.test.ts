import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLocalDriver, type LocalDriver } from './local-driver';
import { UnsupportedQueryError, type StorageDriver } from './types';

interface Row {
  _id: string;
  owner_id?: string;
  person_id?: string;
  conversation_id?: string;
  text?: string;
  start_ms?: number;
  claim?: string;
  claim_normalized?: string;
  primary_source_utterance_id?: string;
  attribute?: string;
  superseded_by?: string;
  embedding?: number[];
  participant_ids?: string[];
}

let dataDir: string;
let driver: LocalDriver;

const utterance = (id: string, fields: Partial<Row> = {}): Row => ({
  _id: id,
  owner_id: 'owner',
  conversation_id: 'c1',
  text: `turn ${id}`,
  start_ms: 0,
  ...fields,
});

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'amelia-store-'));
  driver = await createLocalDriver({ dataDir });
});

afterEach(async () => {
  await driver.close().catch(() => undefined);
  await rm(dataDir, { recursive: true, force: true });
});

async function reopen(): Promise<LocalDriver> {
  await driver.close();
  driver = await createLocalDriver({ dataDir });
  return driver;
}

describe('durability', () => {
  it('a person named today is still named after a restart', async () => {
    await driver.collection<Row>('people').insertOne({ _id: 'p1', owner_id: 'owner', text: 'Maya' });
    await driver.collection<Row>('people').updateOne({ _id: 'p1' }, { $set: { text: 'Maya Chen' } });

    const restarted = await reopen();
    expect(await restarted.collection<Row>('people').findOne({ _id: 'p1' })).toMatchObject({ text: 'Maya Chen' });
  });

  it('replays deletes as well as writes', async () => {
    const people = driver.collection<Row>('people');
    await people.insertOne({ _id: 'p1', owner_id: 'owner' });
    await people.insertOne({ _id: 'p2', owner_id: 'owner' });
    await people.deleteMany({ _id: 'p1' });

    const restarted = await reopen();
    expect((await restarted.collection<Row>('people').find({}).toArray()).map((row) => row._id)).toEqual(['p2']);
  });

  it('survives compaction, which is only a faster way to reach the same state', async () => {
    await driver.close();
    driver = await createLocalDriver({ dataDir, compactAfterRecords: 5 });
    const utterances = driver.collection<Row>('utterances');
    for (let index = 0; index < 5; index += 1) await utterances.insertOne(utterance(`u${index}`));
    for (let round = 0; round < 100; round += 1) {
      await utterances.updateOne({ _id: 'u0' }, { $set: { text: `revision ${round}` } });
    }
    expect((await readFile(join(dataDir, 'journal.log'), 'utf8')).split('\n').filter(Boolean).length).toBeLessThan(105);

    const restarted = await reopen();
    expect(await restarted.collection<Row>('utterances').countDocuments({})).toBe(5);
    expect((await restarted.collection<Row>('utterances').findOne({ _id: 'u0' }))?.text).toBe('revision 99');
  });

  it('preserves 768-float embeddings exactly across a restart', async () => {
    const embedding = Array.from({ length: 768 }, (_, index) => Math.sin(index) * 0.1234567890123);
    await driver.collection<Row>('facts').insertOne({
      _id: 'f1', owner_id: 'owner', person_id: 'p1', claim: 'x', claim_normalized: 'x',
      primary_source_utterance_id: 'u1', embedding,
    });

    const restarted = await reopen();
    const stored = await restarted.collection<Row>('facts').findOne({ _id: 'f1' });
    expect(stored?.embedding).toEqual(embedding);
  });
});

describe('crash safety', () => {
  it('discards a torn final journal line instead of refusing to start', async () => {
    await driver.collection<Row>('people').insertOne({ _id: 'p1', owner_id: 'owner' });
    await driver.close();

    // Exactly what a crash mid-append leaves behind: a truncated last record.
    await appendFile(join(dataDir, 'journal.log'), '{"op":"put","c":"people","d":{"_id":"p2","own');

    driver = await createLocalDriver({ dataDir });
    const ids = (await driver.collection<Row>('people').find({}).toArray()).map((row) => row._id);
    expect(ids).toEqual(['p1']);
  });

  it('ignores a leftover snapshot temp file, so a crash mid-snapshot loses nothing', async () => {
    await driver.collection<Row>('people').insertOne({ _id: 'p1', owner_id: 'owner' });
    await driver.close();
    await writeFile(join(dataDir, 'snapshot.jsonl.tmp'), '{"c":"people","d":{"_id":"garbage"}}\n');

    driver = await createLocalDriver({ dataDir });
    expect((await driver.collection<Row>('people').find({}).toArray()).map((row) => row._id)).toEqual(['p1']);
  });

  it('never publishes a half-written snapshot: the live file always parses', async () => {
    await driver.close();
    driver = await createLocalDriver({ dataDir, compactAfterRecords: 3 });
    const utterances = driver.collection<Row>('utterances');
    for (let index = 0; index < 3; index += 1) await utterances.insertOne(utterance(`u${index}`));
    for (let round = 0; round < 40; round += 1) {
      await utterances.updateOne({ _id: 'u0' }, { $set: { text: `revision ${round}` } });
    }
    const snapshot = await readFile(join(dataDir, 'snapshot.jsonl'), 'utf8');
    expect(snapshot.length).toBeGreaterThan(0);
    for (const line of snapshot.split('\n').filter(Boolean)) expect(() => JSON.parse(line)).not.toThrow();
  });
});

describe('supported query operators', () => {
  beforeEach(async () => {
    const facts = driver.collection<Row>('facts');
    await facts.insertOne({ _id: 'f1', owner_id: 'owner', person_id: 'p1', attribute: 'move', claim: 'moves in September', claim_normalized: 'a', primary_source_utterance_id: 'u1', start_ms: 10, superseded_by: 'f2' });
    await facts.insertOne({ _id: 'f2', owner_id: 'owner', person_id: 'p1', attribute: 'move', claim: 'moves in October', claim_normalized: 'b', primary_source_utterance_id: 'u2', start_ms: 20 });
    await facts.insertOne({ _id: 'f3', owner_id: 'owner', person_id: 'p2', attribute: 'food', claim: 'likes Ethiopian food', claim_normalized: 'c', primary_source_utterance_id: 'u3', start_ms: 30 });
  });

  const ids = async (filter: Record<string, unknown>): Promise<string[]> =>
    (await driver.collection<Row>('facts').find(filter).toArray()).map((row) => row._id).sort();

  it('$in matches listed values', async () => {
    expect(await ids({ person_id: { $in: ['p2'] } })).toEqual(['f3']);
  });

  it('$in with null matches a missing field, as Mongo does', async () => {
    expect(await ids({ superseded_by: { $in: [null, undefined] } })).toEqual(['f2', 'f3']);
  });

  it('$in matches an array field when any element is listed', async () => {
    await driver.collection<Row>('conversations').insertOne({ _id: 'c1', owner_id: 'owner', participant_ids: ['p1', 'p9'] });
    const found = await driver.collection<Row>('conversations').find({ participant_ids: { $in: ['p9'] } }).toArray();
    expect(found.map((row) => row._id)).toEqual(['c1']);
  });

  it('$exists distinguishes absent from present', async () => {
    expect(await ids({ superseded_by: { $exists: true } })).toEqual(['f1']);
    expect(await ids({ superseded_by: { $exists: false } })).toEqual(['f2', 'f3']);
  });

  it('$type narrows to a BSON type', async () => {
    expect(await ids({ superseded_by: { $exists: true, $type: 'string' } })).toEqual(['f1']);
    expect(await ids({ superseded_by: { $type: 'int' } })).toEqual([]);
  });

  it('$ne excludes a value and treats missing as null', async () => {
    expect(await ids({ person_id: { $ne: 'p1' } })).toEqual(['f3']);
    expect(await ids({ superseded_by: { $ne: null } })).toEqual(['f1']);
  });

  it('$gte and $lte bound a range', async () => {
    expect(await ids({ start_ms: { $gte: 20 } })).toEqual(['f2', 'f3']);
    expect(await ids({ start_ms: { $lte: 20 } })).toEqual(['f1', 'f2']);
    expect(await ids({ start_ms: { $gte: 15, $lte: 25 } })).toEqual(['f2']);
  });

  it('$gt and $lt exclude the bound', async () => {
    expect(await ids({ start_ms: { $gt: 20 } })).toEqual(['f3']);
    expect(await ids({ start_ms: { $lt: 20 } })).toEqual(['f1']);
  });

  it('$nin is the inverse of $in', async () => {
    expect(await ids({ person_id: { $nin: ['p1'] } })).toEqual(['f3']);
  });

  it('a bare RegExp matches case-insensitively', async () => {
    expect(await ids({ claim: /ethiopian/i })).toEqual(['f3']);
  });

  it('sorts and limits', async () => {
    const rows = await driver.collection<Row>('facts').find({}).sort({ start_ms: -1 }).limit(2).toArray();
    expect(rows.map((row) => row._id)).toEqual(['f3', 'f2']);
  });

  it('sorts documents missing the key first, as Mongo does ascending', async () => {
    await driver.collection<Row>('facts').insertOne({ _id: 'f0', owner_id: 'owner', person_id: 'p1', claim_normalized: 'z', primary_source_utterance_id: 'u0' });
    const rows = await driver.collection<Row>('facts').find({}).sort({ start_ms: 1 }).toArray();
    expect(rows[0]._id).toBe('f0');
  });

  it('projects only the requested fields', async () => {
    const rows = await driver.collection<Row>('facts').find({ _id: 'f1' }).project({ _id: 1 }).toArray();
    expect(rows).toEqual([{ _id: 'f1' }]);
  });

  it('distinct collapses values', async () => {
    expect((await driver.collection<Row>('facts').distinct('person_id', { owner_id: 'owner' })).sort()).toEqual(['p1', 'p2']);
  });

  it('countDocuments counts matches', async () => {
    expect(await driver.collection<Row>('facts').countDocuments({ person_id: 'p1' })).toBe(2);
  });

  it('$set and $unset edit in place', async () => {
    await driver.collection<Row>('facts').updateMany({ superseded_by: { $in: ['f2'] } }, { $unset: { superseded_by: '' } });
    expect(await ids({ superseded_by: { $exists: true } })).toEqual([]);
  });

  it('$setOnInsert applies only when the upsert creates the row', async () => {
    const conversations = driver.collection<Row>('conversations');
    await conversations.updateOne({ _id: 'c9' }, { $setOnInsert: { owner_id: 'owner', text: 'first' } }, { upsert: true });
    await conversations.updateOne({ _id: 'c9' }, { $setOnInsert: { owner_id: 'someone-else', text: 'second' } }, { upsert: true });
    expect(await conversations.findOne({ _id: 'c9' })).toMatchObject({ owner_id: 'owner', text: 'first' });
  });

  it('an upsert seeds the document from the filter equalities', async () => {
    await driver.collection<Row>('utterances').updateOne(
      { _id: 'u-new', owner_id: 'owner' },
      { $set: { text: 'hello' } },
      { upsert: true },
    );
    expect(await driver.collection<Row>('utterances').findOne({ _id: 'u-new' })).toMatchObject({
      _id: 'u-new', owner_id: 'owner', text: 'hello',
    });
  });

  it('findOneAndUpdate returns the updated document', async () => {
    const updated = await driver
      .collection<Row>('facts')
      .findOneAndUpdate({ _id: 'f3' }, { $set: { claim: 'edited' } }, { returnDocument: 'after' });
    expect(updated?.claim).toBe('edited');
  });

  it('findOne honours a sort', async () => {
    const newest = await driver.collection<Row>('facts').findOne({ person_id: 'p1' }, { sort: { start_ms: -1 } });
    expect(newest?._id).toBe('f2');
  });
});

describe('unsupported queries throw rather than answer wrongly', () => {
  it('rejects an unknown field operator', async () => {
    await expect(driver.collection<Row>('facts').find({ start_ms: { $mod: [2, 0] } }).toArray()).rejects.toThrow(
      UnsupportedQueryError,
    );
  });

  it('rejects a top-level logical operator it does not implement', async () => {
    await expect(driver.collection<Row>('facts').find({ $or: [{ _id: 'f1' }] }).toArray()).rejects.toThrow(
      UnsupportedQueryError,
    );
  });

  it('rejects an unknown update operator', async () => {
    await expect(
      driver.collection<Row>('facts').updateOne({ _id: 'f1' }, { $inc: { start_ms: 1 } } as never),
    ).rejects.toThrow(UnsupportedQueryError);
  });

  it('rejects an unimplemented aggregation stage', async () => {
    await expect(driver.collection<Row>('facts').aggregate([{ $group: { _id: null } }]).toArray()).rejects.toThrow(
      UnsupportedQueryError,
    );
  });
});

describe('unique indexes', () => {
  const fact = (id: string, source: string, normalized: string): Row => ({
    _id: id, owner_id: 'owner', person_id: 'p1', claim: 'c', claim_normalized: normalized,
    primary_source_utterance_id: source,
  });

  it('rejects a replayed extraction with a Mongo-shaped duplicate-key error', async () => {
    await driver.collection<Row>('facts').insertOne(fact('f1', 'u1', 'same'));
    await expect(driver.collection<Row>('facts').insertOne(fact('f2', 'u1', 'same'))).rejects.toMatchObject({
      code: 11_000,
    });
  });

  it('rejects a reused _id', async () => {
    await driver.collection<Row>('people').insertOne({ _id: 'p1' });
    await expect(driver.collection<Row>('people').insertOne({ _id: 'p1' })).rejects.toMatchObject({ code: 11_000 });
  });

  it('keeps the constraint across a restart', async () => {
    await driver.collection<Row>('facts').insertOne(fact('f1', 'u1', 'same'));
    const restarted = await reopen();
    await expect(restarted.collection<Row>('facts').insertOne(fact('f2', 'u1', 'same'))).rejects.toMatchObject({
      code: 11_000,
    });
  });

  it('leaves no trace of a rejected write in the journal', async () => {
    await driver.collection<Row>('facts').insertOne(fact('f1', 'u1', 'same'));
    await driver.collection<Row>('facts').insertOne(fact('f2', 'u1', 'other')).catch(() => undefined);
    await driver.collection<Row>('facts').insertOne(fact('f3', 'u1', 'same')).catch(() => undefined);

    const restarted = await reopen();
    expect((await restarted.collection<Row>('facts').find({}).toArray()).map((row) => row._id).sort()).toEqual([
      'f1', 'f2',
    ]);
  });
});

describe('concurrency', () => {
  it('serialises overlapping writes without losing any', async () => {
    const writes = Array.from({ length: 200 }, (_, index) =>
      driver.collection<Row>('utterances').insertOne(utterance(`u${index}`)),
    );
    await Promise.all(writes);

    const restarted = await reopen();
    expect(await restarted.collection<Row>('utterances').countDocuments({})).toBe(200);
  });

  it('keeps the journal one whole record per line under concurrent writes', async () => {
    await Promise.all(
      Array.from({ length: 100 }, (_, index) => driver.collection<Row>('people').insertOne({ _id: `p${index}` })),
    );
    const lines = (await readFile(join(dataDir, 'journal.log'), 'utf8')).split('\n').filter(Boolean);
    expect(lines).toHaveLength(100);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it('interleaved updates to one document end at a single consistent value', async () => {
    await driver.collection<Row>('people').insertOne({ _id: 'p1', text: 'start' });
    await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        driver.collection<Row>('people').updateOne({ _id: 'p1' }, { $set: { text: `v${index}` } }),
      ),
    );
    const restarted = await reopen();
    const stored = await restarted.collection<Row>('people').findOne({ _id: 'p1' });
    expect(stored?.text).toBe('v49');
  });
});

describe('transactions', () => {
  it('commits every write or none of them', async () => {
    const people = driver.collection<Row>('people');
    await people.insertOne({ _id: 'p1', owner_id: 'owner' });
    await people.insertOne({ _id: 'p2', owner_id: 'owner' });

    await expect(
      driver.transact(async (collection) => {
        await collection<Row>('people').deleteMany({ _id: 'p2' });
        await collection<Row>('utterances').insertOne(utterance('u1', { person_id: 'p1' }));
        throw new Error('halfway failure');
      }),
    ).rejects.toThrow('halfway failure');

    expect((await people.find({}).toArray()).map((row) => row._id).sort()).toEqual(['p1', 'p2']);
    expect(await driver.collection<Row>('utterances').countDocuments({})).toBe(0);

    const restarted = await reopen();
    expect(await restarted.collection<Row>('people').countDocuments({})).toBe(2);
    expect(await restarted.collection<Row>('utterances').countDocuments({})).toBe(0);
  });

  it('writes a committed transaction as one journal record', async () => {
    await driver.transact(async (collection) => {
      await collection<Row>('people').insertOne({ _id: 'p1' });
      await collection<Row>('people').insertOne({ _id: 'p2' });
      await collection<Row>('utterances').insertOne(utterance('u1'));
    });
    const lines = (await readFile(join(dataDir, 'journal.log'), 'utf8')).split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).op).toBe('tx');
  });

  it('reads its own uncommitted writes', async () => {
    const seen = await driver.transact(async (collection) => {
      await collection<Row>('people').insertOne({ _id: 'p1', text: 'Maya' });
      return collection<Row>('people').findOne({ _id: 'p1' });
    });
    expect(seen?.text).toBe('Maya');
  });
});

describe('vector search', () => {
  it('ranks by exact cosine and reports Atlas-normalised scores', async () => {
    const facts = driver.collection<Row>('facts');
    await facts.insertOne({ _id: 'f1', owner_id: 'owner', person_id: 'p1', claim_normalized: 'a', primary_source_utterance_id: 'u1', embedding: [1, 0, 0] });
    await facts.insertOne({ _id: 'f2', owner_id: 'owner', person_id: 'p1', claim_normalized: 'b', primary_source_utterance_id: 'u2', embedding: [0, 1, 0] });
    await facts.insertOne({ _id: 'f3', owner_id: 'owner', person_id: 'p2', claim_normalized: 'c', primary_source_utterance_id: 'u3', embedding: [1, 0, 0] });

    const results = await facts
      .aggregate<{ _id: string; score: number }>([
        { $vectorSearch: { index: 'facts_vector', path: 'embedding', queryVector: [1, 0, 0], filter: { owner_id: 'owner', person_id: 'p1' }, numCandidates: 60, limit: 2 } },
        { $project: { _id: 1, score: { $meta: 'vectorSearchScore' } } },
      ])
      .toArray();

    expect(results.map((row) => row._id)).toEqual(['f1', 'f2']);
    expect(results[0].score).toBeCloseTo(1);
    expect(results[1].score).toBeCloseTo(0.5);
  });

  it('skips documents that have no vector rather than scoring them zero', async () => {
    const facts = driver.collection<Row>('facts');
    await facts.insertOne({ _id: 'f1', owner_id: 'owner', claim_normalized: 'a', primary_source_utterance_id: 'u1' });
    const results = await facts
      .aggregate([{ $vectorSearch: { path: 'embedding', queryVector: [1, 0, 0], limit: 5 } }])
      .toArray();
    expect(results).toEqual([]);
  });
});

describe('text scans', () => {
  it('finds substring matches the inverted index narrowed down to', async () => {
    const utterances = driver.collection<Row>('utterances');
    for (let index = 0; index < 500; index += 1) {
      await utterances.insertOne(utterance(`u${index}`, { text: `nothing interesting here ${index}` }));
    }
    await utterances.insertOne(utterance('needle', { text: 'we are packing the apartment tomorrow' }));

    const found = await utterances.find({ owner_id: 'owner', text: /packing|xylophone/i }).toArray();
    expect(found.map((row) => row._id)).toEqual(['needle']);
  });

  it('still matches a word the query only prefixes', async () => {
    await driver.collection<Row>('utterances').insertOne(utterance('u1', { text: 'she is packing boxes' }));
    const found = await driver.collection<Row>('utterances').find({ text: /pack/i }).toArray();
    expect(found.map((row) => row._id)).toEqual(['u1']);
  });

  it('reflects an edit in the index rather than the stale token', async () => {
    const utterances = driver.collection<Row>('utterances');
    await utterances.insertOne(utterance('u1', { text: 'ethiopian food' }));
    await utterances.updateOne({ _id: 'u1' }, { $set: { text: 'thai food' } });

    expect(await utterances.find({ text: /ethiopian/i }).toArray()).toEqual([]);
    expect((await utterances.find({ text: /thai/i }).toArray()).map((row) => row._id)).toEqual(['u1']);
  });
});

describe('isolation from the caller', () => {
  it('does not let a caller mutate stored state through a returned document', async () => {
    await driver.collection<Row>('people').insertOne({ _id: 'p1', text: 'Maya' });
    const found = await driver.collection<Row>('people').findOne({ _id: 'p1' });
    if (found) found.text = 'tampered';
    expect((await driver.collection<Row>('people').findOne({ _id: 'p1' }))?.text).toBe('Maya');
  });

  it('does not keep a live reference to the inserted object', async () => {
    const document: Row = { _id: 'p1', text: 'Maya' };
    await driver.collection<Row>('people').insertOne(document);
    document.text = 'tampered';
    expect((await driver.collection<Row>('people').findOne({ _id: 'p1' }))?.text).toBe('Maya');
  });
});

describe('the driver contract', () => {
  it('satisfies StorageDriver', () => {
    const asDriver: StorageDriver = driver;
    expect(asDriver.kind).toBe('local');
  });
});
