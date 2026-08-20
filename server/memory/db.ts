import type {
  Conversation,
  Fact,
  Person,
  PromiseMemory,
  Reminder,
  Utterance,
  Voiceprint,
} from '../../shared/contracts';
import {
  closeStorage,
  getStorage,
  type AggregationCursor,
  type DeleteResult,
  type Filter,
  type PipelineStage,
  type ProjectionSpec,
  type SortSpec,
  type StorageCollection,
  type StorageCursor,
  type StorageDriver,
  type UpdateResult,
  type UpdateSpec,
} from '../storage';

export type { StorageCollection, StorageDriver } from '../storage';
export { getStorage, initStorage, storageHealth, type StorageHealth } from '../storage';

/**
 * Callers reach for `collections.facts()` synchronously, but choosing a backend
 * means probing the network. These handles defer: every method resolves the
 * driver first, so nothing has to be awaited before the collection exists and
 * one slow probe cannot be raced into two drivers.
 */
function deferredCollection<T extends { _id: string }>(name: string): StorageCollection<T> {
  const resolve = async (): Promise<StorageCollection<T>> => (await getStorage()).collection<T>(name);

  return {
    async insertOne(document) {
      return (await resolve()).insertOne(document);
    },
    find(filter?: Filter, options?: { sort?: SortSpec; limit?: number }): StorageCursor<T> {
      return deferredCursor<T>(async () => (await resolve()).find(filter, options));
    },
    async findOne(filter, options) {
      return (await resolve()).findOne(filter, options);
    },
    async findOneAndUpdate(filter, update, options) {
      return (await resolve()).findOneAndUpdate(filter, update, options);
    },
    async updateOne(filter: Filter, update: UpdateSpec, options?: { upsert?: boolean }): Promise<UpdateResult> {
      return (await resolve()).updateOne(filter, update, options);
    },
    async updateMany(filter: Filter, update: UpdateSpec): Promise<UpdateResult> {
      return (await resolve()).updateMany(filter, update);
    },
    async deleteOne(filter: Filter): Promise<DeleteResult> {
      return (await resolve()).deleteOne(filter);
    },
    async deleteMany(filter: Filter): Promise<DeleteResult> {
      return (await resolve()).deleteMany(filter);
    },
    async distinct(key, filter) {
      return (await resolve()).distinct(key, filter);
    },
    async countDocuments(filter) {
      return (await resolve()).countDocuments(filter);
    },
    aggregate<R extends object>(pipeline: PipelineStage[]): AggregationCursor<R> {
      return { toArray: async () => (await resolve()).aggregate<R>(pipeline).toArray() };
    },
  };
}

function deferredCursor<T>(open: () => Promise<StorageCursor<T>>): StorageCursor<T> {
  const staged: Array<(cursor: StorageCursor<T>) => StorageCursor<unknown>> = [];
  const cursor: StorageCursor<T> = {
    sort(spec: SortSpec) {
      staged.push((inner) => inner.sort(spec) as StorageCursor<unknown>);
      return cursor;
    },
    limit(count: number) {
      staged.push((inner) => inner.limit(count) as StorageCursor<unknown>);
      return cursor;
    },
    project(spec: ProjectionSpec) {
      staged.push((inner) => inner.project(spec) as StorageCursor<unknown>);
      return cursor as unknown as StorageCursor<Partial<T>>;
    },
    async toArray() {
      let inner = (await open()) as StorageCursor<unknown>;
      for (const stage of staged) inner = stage(inner as StorageCursor<T>);
      return (await inner.toArray()) as T[];
    },
  };
  return cursor;
}

export const collections = {
  people: () => deferredCollection<Person>('people'),
  voiceprints: () => deferredCollection<Voiceprint>('voiceprints'),
  conversations: () => deferredCollection<Conversation>('conversations'),
  utterances: () => deferredCollection<Utterance>('utterances'),
  facts: () => deferredCollection<Fact>('facts'),
  promises: () => deferredCollection<PromiseMemory>('promises'),
  reminders: () => deferredCollection<Reminder>('reminders'),
};

export async function closeDb(): Promise<void> {
  await closeStorage();
}

const DUPLICATE_KEY = 11_000;

export function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: number } | undefined)?.code === DUPLICATE_KEY;
}

/**
 * Extraction is replayed whenever a transcript is re-run, and the unique
 * idempotency indexes are what make that safe. A duplicate means the document
 * already exists, so hand back the stored copy rather than failing the pass.
 */
export async function insertIdempotent<T extends { _id: string }>(
  collection: StorageCollection<T>,
  document: T,
  identity: Filter,
): Promise<{ document: T; created: boolean }> {
  try {
    await collection.insertOne(document);
    return { document, created: true };
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    const existing = await collection.findOne(identity);
    if (!existing) throw error;
    return { document: existing, created: false };
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
