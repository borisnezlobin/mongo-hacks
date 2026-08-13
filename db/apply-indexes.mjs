import { readFile } from 'node:fs/promises';
import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI;
if (!uri) throw new Error('MONGODB_URI is required');

const config = JSON.parse(await readFile(new URL('./indexes.json', import.meta.url), 'utf8'));
const client = new MongoClient(uri);

async function ensureSearchIndex(db, spec) {
  const collection = db.collection(spec.collection);
  const existing = await collection.listSearchIndexes(spec.name).toArray();
  if (existing.length === 0) {
    await collection.createSearchIndex({ name: spec.name, type: spec.type, definition: spec.definition });
    console.log(`created search index ${spec.collection}.${spec.name}`);
    return;
  }
  await collection.updateSearchIndex(spec.name, spec.definition);
  console.log(`updated search index ${spec.collection}.${spec.name}`);
}

async function main() {
  await client.connect();
  const db = client.db();
  for (const spec of config.collectionIndexes) {
    await db.collection(spec.collection).createIndex(spec.keys, spec.options);
    console.log(`ensured collection index ${spec.collection}.${spec.options.name}`);
  }
  for (const spec of config.searchIndexes) await ensureSearchIndex(db, spec);
  console.log('Atlas bootstrap complete: facts + voiceprints vector indexes and utterance Search');
}

main().finally(() => client.close());
