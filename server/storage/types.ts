/**
 * The storage contract the rest of the server codes against.
 *
 * Deliberately a strict subset of the Mongo collection surface — the subset this
 * repository actually uses — so a `mongodb` Collection satisfies it structurally
 * and the local driver can implement it exactly. Anything outside the subset
 * throws {@link UnsupportedQueryError} rather than quietly returning a wrong
 * answer, because a silently wrong memory is worse than a loud failure.
 */

export type Filter = Record<string, unknown>;
export type SortSpec = Record<string, 1 | -1>;
export type ProjectionSpec = Record<string, 0 | 1>;

export interface UpdateSpec {
  $set?: Record<string, unknown>;
  $setOnInsert?: Record<string, unknown>;
  $unset?: Record<string, unknown>;
}

export interface UpdateResult {
  matchedCount: number;
  modifiedCount: number;
  upsertedCount: number;
  upsertedId: string | null;
}

export interface DeleteResult {
  deletedCount: number;
}

export interface StorageCursor<T> {
  sort(spec: SortSpec): StorageCursor<T>;
  limit(count: number): StorageCursor<T>;
  project(spec: ProjectionSpec): StorageCursor<Partial<T>>;
  toArray(): Promise<T[]>;
}

export interface AggregationCursor<T> {
  toArray(): Promise<T[]>;
}

export type PipelineStage = Record<string, unknown>;

export interface StorageCollection<T extends object> {
  insertOne(document: T): Promise<{ insertedId: string }>;
  find(filter?: Filter, options?: { sort?: SortSpec; limit?: number }): StorageCursor<T>;
  findOne(filter: Filter, options?: { sort?: SortSpec }): Promise<T | null>;
  findOneAndUpdate(
    filter: Filter,
    update: UpdateSpec,
    options?: { returnDocument?: 'before' | 'after'; upsert?: boolean },
  ): Promise<T | null>;
  updateOne(filter: Filter, update: UpdateSpec, options?: { upsert?: boolean }): Promise<UpdateResult>;
  updateMany(filter: Filter, update: UpdateSpec): Promise<UpdateResult>;
  deleteOne(filter: Filter): Promise<DeleteResult>;
  deleteMany(filter: Filter): Promise<DeleteResult>;
  distinct(key: string, filter?: Filter): Promise<unknown[]>;
  countDocuments(filter?: Filter): Promise<number>;
  aggregate<R extends object = T>(pipeline: PipelineStage[]): AggregationCursor<R>;
}

/** Collection accessor handed to a {@link StorageDriver.transact} body. */
export type TransactionScope = <T extends { _id: string }>(name: string) => StorageCollection<T>;

export type DriverKind = 'mongo' | 'local';

export interface StorageDriver {
  readonly kind: DriverKind;
  collection<T extends { _id: string }>(name: string): StorageCollection<T>;
  /**
   * Runs `body` so that either every write inside it lands or none of them do.
   * The local driver commits the whole batch as one journal record; the Mongo
   * driver uses a session transaction.
   */
  transact<R>(body: (collection: TransactionScope) => Promise<R>): Promise<R>;
  close(): Promise<void>;
}

/** A query, update or pipeline stage outside the supported subset. */
export class UnsupportedQueryError extends Error {
  constructor(message: string) {
    super(`${message} — the local storage driver implements only the subset of Mongo this repo uses`);
    this.name = 'UnsupportedQueryError';
  }
}

/** Shaped so `isDuplicateKey` treats local and Mongo violations identically. */
export class DuplicateKeyError extends Error {
  readonly code = 11_000;

  constructor(readonly indexName: string, readonly key: string) {
    super(`E11000 duplicate key error collection index: ${indexName} dup key: { ${key} }`);
    this.name = 'DuplicateKeyError';
  }
}
