import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';

// Nothing loads dotenv for standalone scripts; read the same files the server does.
for (const relative of ['../.env', '../server/.env']) {
  try {
    process.loadEnvFile(fileURLToPath(new URL(relative, import.meta.url)));
  } catch {
    /* absent — fall through to the ambient environment */
  }
}

const uri = process.env.MONGODB_URI;
if (!uri) throw new Error('MONGODB_URI is required (see server/.env.example)');

const prune = process.argv.includes('--prune');
const config = JSON.parse(await readFile(new URL('./indexes.json', import.meta.url), 'utf8'));
const client = new MongoClient(uri);

const COLLECTIONS = ['people', 'voiceprints', 'conversations', 'utterances', 'facts', 'promises', 'reminders'];

async function ensureCollections(db) {
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((item) => item.name));
  for (const name of COLLECTIONS) {
    if (existing.has(name)) continue;
    await db.createCollection(name);
    console.log(`created collection ${name}`);
  }
}

/** Atlas Search and vector indexes share one cluster-wide allowance on sandbox tiers. */
async function surveySearchIndexes(db) {
  const found = [];
  for (const name of COLLECTIONS) {
    const indexes = await db.collection(name).listSearchIndexes().toArray();
    for (const index of indexes) found.push({ collection: name, name: index.name, status: index.status });
  }
  return found;
}

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
  console.log(`database: ${db.databaseName}`);
  await ensureCollections(db);

  for (const spec of config.collectionIndexes) {
    await db.collection(spec.collection).createIndex(spec.keys, spec.options);
    console.log(`ensured collection index ${spec.collection}.${spec.options.name}`);
  }

  const declared = new Set(config.searchIndexes.map((spec) => `${spec.collection}.${spec.name}`));
  const obsolete = (await surveySearchIndexes(db)).filter(
    (index) => !declared.has(`${index.collection}.${index.name}`),
  );
  for (const index of obsolete) {
    if (!prune) {
      console.warn(
        `undeclared search index ${index.collection}.${index.name} occupies a slot; rerun with --prune to drop it`,
      );
      continue;
    }
    await db.collection(index.collection).dropSearchIndex(index.name);
    console.log(`dropped search index ${index.collection}.${index.name}`);
  }

  const wanted = config.searchIndexes.length + (prune ? 0 : obsolete.length);
  if (wanted > config.searchIndexCap) {
    throw new Error(
      `search index allowance exceeded: ${wanted} wanted, cap is ${config.searchIndexCap}. Drop the undeclared indexes listed above (--prune) before retrying.`,
    );
  }

  for (const spec of config.searchIndexes) await ensureSearchIndex(db, spec);

  const survey = await surveySearchIndexes(db);
  console.log(`Atlas bootstrap complete: ${survey.length}/${config.searchIndexCap} search indexes in use`);
  for (const index of survey) console.log(`  ${index.collection}.${index.name} — ${index.status ?? 'unknown'}`);
}

main().finally(() => client.close());
