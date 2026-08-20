/**
 * Move memory between the local store and Atlas.
 *
 *   npx tsx db/migrate.mts push          copy local -> Mongo
 *   npx tsx db/migrate.mts pull          copy Mongo -> local
 *   npx tsx db/migrate.mts status        what is where
 *
 * Options:
 *   --replace     empty the destination collections first (default: merge by _id)
 *   --dry-run     report what would move, write nothing
 *   --only=facts,people
 *
 * Copying is by `_id`, so a merge is idempotent: running push twice writes the
 * same documents twice and leaves the same result. Nothing here has been run
 * against a live cluster — Atlas is unreachable from the network this was built
 * on — so treat the first real run as the test and use --dry-run first.
 */
import { COLLECTION_NAMES, createLocalDriver, createMongoDriver, localDataDir } from '../server/storage/index';
import type { StorageCollection, StorageDriver } from '../server/storage/index';
import { loadEnv } from '../server/memory/env';

interface Options {
  direction: 'push' | 'pull' | 'status';
  replace: boolean;
  dryRun: boolean;
  only: string[];
}

function parseArguments(argv: string[]): Options {
  const direction = argv.find((argument) => ['push', 'pull', 'status'].includes(argument)) as Options['direction'];
  if (!direction) throw new Error('usage: npx tsx db/migrate.mts <push|pull|status> [--replace] [--dry-run] [--only=a,b]');
  const only = argv.find((argument) => argument.startsWith('--only='))?.slice('--only='.length).split(',') ?? [];
  for (const name of only) {
    if (!COLLECTION_NAMES.includes(name as (typeof COLLECTION_NAMES)[number])) {
      throw new Error(`unknown collection "${name}"`);
    }
  }
  return {
    direction,
    replace: argv.includes('--replace'),
    dryRun: argv.includes('--dry-run'),
    only: only.length > 0 ? only : [...COLLECTION_NAMES],
  };
}

async function openMongo(): Promise<StorageDriver> {
  loadEnv();
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required to migrate (see .env.example)');
  return createMongoDriver({ uri, serverSelectionTimeoutMs: 10_000 });
}

async function copy(
  source: StorageCollection<{ _id: string }>,
  destination: StorageCollection<{ _id: string }>,
  options: Options,
): Promise<{ read: number; written: number }> {
  const documents = await source.find({}).toArray();
  if (options.dryRun) return { read: documents.length, written: 0 };
  if (options.replace) await destination.deleteMany({});

  let written = 0;
  for (const document of documents) {
    const { _id, ...fields } = document as Record<string, unknown> & { _id: string };
    await destination.updateOne({ _id }, { $set: fields }, { upsert: true });
    written += 1;
  }
  return { read: documents.length, written };
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const local = await createLocalDriver({ dataDir: localDataDir() });

  try {
    if (options.direction === 'status') {
      console.log(`local: ${localDataDir()}`);
      for (const name of options.only) {
        console.log(`  ${name.padEnd(14)} ${await local.collection(name).countDocuments({})}`);
      }
      const mongo = await openMongo().catch((error: unknown) => {
        console.log(`mongo: unreachable — ${(error as Error).message}`);
        return undefined;
      });
      if (!mongo) return;
      console.log('mongo:');
      for (const name of options.only) {
        console.log(`  ${name.padEnd(14)} ${await mongo.collection(name).countDocuments({})}`);
      }
      await mongo.close();
      return;
    }

    const mongo = await openMongo();
    try {
      const [from, to] = options.direction === 'push' ? [local, mongo] : [mongo, local];
      console.log(`${options.direction}: ${from.kind} -> ${to.kind}${options.dryRun ? ' (dry run)' : ''}`);
      let total = 0;
      for (const name of options.only) {
        const result = await copy(from.collection(name), to.collection(name), options);
        total += result.written;
        console.log(`  ${name.padEnd(14)} read ${result.read}, wrote ${result.written}`);
      }
      console.log(options.dryRun ? 'dry run complete, nothing written' : `migration complete, ${total} documents written`);
    } finally {
      await mongo.close();
    }
  } finally {
    await local.close();
  }
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
