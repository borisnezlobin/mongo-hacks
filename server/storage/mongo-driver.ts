/**
 * The Mongo backend, behind the same interface as the local one.
 *
 * The driver's own Collection already implements most of the contract, so this
 * is mostly a typed pass-through. The parts worth writing are the eager
 * `connect()` + ping (so an unreachable cluster fails in seconds instead of
 * hanging on the first query) and `transact`, which the local driver gets for
 * free from its journal but Mongo needs a session for.
 */
import { MongoClient, type ClientSession, type Collection, type Db } from 'mongodb';
import type {
  AggregationCursor,
  DeleteResult,
  Filter,
  PipelineStage,
  ProjectionSpec,
  SortSpec,
  StorageCollection,
  StorageCursor,
  StorageDriver,
  TransactionScope,
  UpdateResult,
  UpdateSpec,
} from './types';

export interface MongoDriverOptions {
  uri: string;
  /** How long to wait for the cluster before declaring it unreachable. */
  serverSelectionTimeoutMs?: number;
}

export const DEFAULT_SERVER_SELECTION_TIMEOUT_MS = 3_000;

type AnyCollection = Collection<Record<string, unknown>>;

function wrapCursor<T>(build: (options: { session?: ClientSession }) => AnyCollection, filter: Filter, session?: ClientSession): StorageCursor<T> {
  let sortSpec: SortSpec | undefined;
  let limitCount: number | undefined;
  let projection: ProjectionSpec | undefined;

  const cursor: StorageCursor<T> = {
    sort(spec) {
      sortSpec = spec;
      return cursor;
    },
    limit(count) {
      limitCount = count;
      return cursor;
    },
    project(spec) {
      projection = spec;
      return cursor as unknown as StorageCursor<Partial<T>>;
    },
    async toArray() {
      let native = build({ session }).find(filter, { session });
      if (sortSpec) native = native.sort(sortSpec);
      if (limitCount !== undefined) native = native.limit(limitCount);
      if (projection) native = native.project(projection) as typeof native;
      return (await native.toArray()) as T[];
    },
  };
  return cursor;
}

function wrapCollection<T extends { _id: string }>(
  db: Db,
  name: string,
  session?: ClientSession,
): StorageCollection<T> {
  const native = (): AnyCollection => db.collection(name);

  return {
    async insertOne(document) {
      const result = await native().insertOne(document as Record<string, unknown>, { session });
      return { insertedId: String(result.insertedId) };
    },
    find(filter = {}, options = {}) {
      const cursor = wrapCursor<T>(() => native(), filter, session);
      if (options.sort) cursor.sort(options.sort);
      if (options.limit !== undefined) cursor.limit(options.limit);
      return cursor;
    },
    async findOne(filter, options = {}) {
      return (await native().findOne(filter, { session, ...(options.sort ? { sort: options.sort } : {}) })) as T | null;
    },
    async findOneAndUpdate(filter, update, options = {}) {
      return (await native().findOneAndUpdate(filter, update as never, {
        session,
        returnDocument: options.returnDocument ?? 'after',
        upsert: options.upsert ?? false,
      })) as T | null;
    },
    async updateOne(filter, update, options = {}) {
      const result = await native().updateOne(filter, update as never, { session, upsert: options.upsert ?? false });
      return {
        matchedCount: result.matchedCount,
        modifiedCount: result.modifiedCount,
        upsertedCount: result.upsertedCount,
        upsertedId: result.upsertedId === null ? null : String(result.upsertedId),
      };
    },
    async updateMany(filter, update) {
      const result = await native().updateMany(filter, update as never, { session });
      return {
        matchedCount: result.matchedCount,
        modifiedCount: result.modifiedCount,
        upsertedCount: result.upsertedCount,
        upsertedId: result.upsertedId === null ? null : String(result.upsertedId),
      };
    },
    async deleteOne(filter): Promise<DeleteResult> {
      return { deletedCount: (await native().deleteOne(filter, { session })).deletedCount };
    },
    async deleteMany(filter): Promise<DeleteResult> {
      return { deletedCount: (await native().deleteMany(filter, { session })).deletedCount };
    },
    async distinct(key, filter = {}) {
      return native().distinct(key, filter, { session });
    },
    async countDocuments(filter = {}) {
      return native().countDocuments(filter, { session });
    },
    aggregate<R extends object>(pipeline: PipelineStage[]): AggregationCursor<R> {
      return {
        toArray: async () => (await native().aggregate(pipeline, { session }).toArray()) as R[],
      };
    },
  };
}

export interface MongoDriver extends StorageDriver {
  readonly kind: 'mongo';
  readonly client: MongoClient;
}

/**
 * Connects and pings before returning. The previous `getDb()` built a client and
 * cached the `Db` without ever awaiting `connect()`, so an unreachable cluster
 * looked healthy until the first query timed out — and the bad handle stayed
 * cached afterwards.
 */
export async function createMongoDriver(options: MongoDriverOptions): Promise<MongoDriver> {
  const timeout = options.serverSelectionTimeoutMs ?? DEFAULT_SERVER_SELECTION_TIMEOUT_MS;
  const client = new MongoClient(options.uri, {
    serverSelectionTimeoutMS: timeout,
    connectTimeoutMS: timeout,
  });

  try {
    await client.connect();
    await client.db().command({ ping: 1 });
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }

  const db = client.db();
  let transactionsUnsupported = false;

  return {
    kind: 'mongo',
    client,
    collection<T extends { _id: string }>(name: string) {
      return wrapCollection<T>(db, name);
    },
    async transact<R>(body: (collection: TransactionScope) => Promise<R>): Promise<R> {
      const sessionless: TransactionScope = <T extends { _id: string }>(name: string) =>
        wrapCollection<T>(db, name);
      if (transactionsUnsupported) return body(sessionless);

      const session = client.startSession();
      try {
        let result: R | undefined;
        await session.withTransaction(async () => {
          result = await body(<T extends { _id: string }>(name: string) => wrapCollection<T>(db, name, session));
        });
        return result as R;
      } catch (error) {
        if (!isTransactionUnsupported(error)) throw error;
        // Standalone deployments have no transactions. Degrading to sequential
        // writes is worse than atomic, so say so rather than hiding it.
        console.warn('[storage] cluster does not support transactions; writes will not be atomic:', (error as Error).message);
        transactionsUnsupported = true;
        return body(sessionless);
      } finally {
        await session.endSession().catch(() => undefined);
      }
    },
    close: () => client.close(),
  };
}

function isTransactionUnsupported(error: unknown): boolean {
  const message = (error as Error | undefined)?.message ?? '';
  return /Transaction numbers are only allowed|replica set|not supported|IllegalOperation/i.test(message);
}
