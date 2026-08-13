import { MongoClient, type Collection, type Db, type MongoServerError } from 'mongodb';
import type {
  Conversation,
  Fact,
  Person,
  PromiseMemory,
  Reminder,
  Utterance,
  Voiceprint,
} from '../../shared/contracts';
import { requireEnv } from './env';

let client: MongoClient | undefined;
let database: Db | undefined;

export function getDb(): Db {
  if (database) return database;
  client = new MongoClient(requireEnv('MONGODB_URI'));
  database = client.db();
  return database;
}

export async function closeDb(): Promise<void> {
  await client?.close();
  client = undefined;
  database = undefined;
}

export const collections = {
  people: () => getDb().collection<Person>('people'),
  voiceprints: () => getDb().collection<Voiceprint>('voiceprints'),
  conversations: () => getDb().collection<Conversation>('conversations'),
  utterances: () => getDb().collection<Utterance>('utterances'),
  facts: () => getDb().collection<Fact>('facts'),
  promises: () => getDb().collection<PromiseMemory>('promises'),
  reminders: () => getDb().collection<Reminder>('reminders'),
};

const DUPLICATE_KEY = 11_000;

export function isDuplicateKey(error: unknown): boolean {
  return (error as MongoServerError | undefined)?.code === DUPLICATE_KEY;
}

/**
 * Extraction is replayed whenever a transcript is re-run, and the unique
 * idempotency indexes are what make that safe. A duplicate means the document
 * already exists, so hand back the stored copy rather than failing the pass.
 */
export async function insertIdempotent<T extends { _id: string }>(
  collection: Collection<T>,
  document: T,
  identity: Partial<T>,
): Promise<{ document: T; created: boolean }> {
  try {
    await collection.insertOne(document as Parameters<Collection<T>['insertOne']>[0]);
    return { document, created: true };
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    const existing = await collection.findOne(identity as Parameters<Collection<T>['findOne']>[0]);
    if (!existing) throw error;
    return { document: existing as T, created: false };
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
