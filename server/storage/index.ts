/**
 * Which backend memory lives in, and whether it is telling the truth about that.
 *
 * Atlas is optional. If `MONGODB_URI` is set and the cluster answers a ping
 * within a short timeout, memory goes to Atlas. Otherwise it goes to a durable
 * local store and the process says so — loudly at startup and structurally
 * through {@link storageHealth}, so `/health` and the app can render "running on
 * local storage" instead of a green tick over a dead database.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadEnv } from '../memory/env';
import { createLocalDriver, type LocalDriver } from './local-driver';
import { createMongoDriver, DEFAULT_SERVER_SELECTION_TIMEOUT_MS } from './mongo-driver';
import type { DriverKind, StorageDriver } from './types';

export * from './types';
export { SCHEMA, COLLECTION_NAMES, type CollectionName } from './schema';
export { createLocalDriver, removeLocalStore, type LocalDriver } from './local-driver';
export { createMongoDriver, type MongoDriver } from './mongo-driver';
export { cosineSimilarity, rankByCosine, toAtlasScore } from './vector';

export interface StorageHealth {
  driver: DriverKind;
  data_dir?: string;
  mongo: {
    configured: boolean;
    reachable: boolean;
    error?: string;
  };
  /** True when Atlas was asked for and could not be reached. */
  degraded: boolean;
  selected_at: string;
}

let driverPromise: Promise<StorageDriver> | undefined;
let health: StorageHealth | undefined;

export function localDataDir(): string {
  loadEnv();
  return process.env.AMELIA_DATA_DIR ?? join(homedir(), '.amelia', 'data');
}

function mongoTimeoutMs(): number {
  const configured = Number(process.env.AMELIA_MONGO_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_SERVER_SELECTION_TIMEOUT_MS;
}

/** `degraded` means Atlas was wanted and could not be had — not merely that local is in use. */
async function openLocal(mongo: StorageHealth['mongo'], degraded: boolean): Promise<LocalDriver> {
  const dataDir = localDataDir();
  const driver = await createLocalDriver({ dataDir });
  health = { driver: 'local', data_dir: dataDir, mongo, degraded, selected_at: new Date().toISOString() };
  if (degraded) {
    console.warn(
      `[storage] MongoDB is unreachable (${mongo.error ?? 'unknown error'}). Falling back to local storage at ${dataDir}. ` +
        'Memory is durable but this process is not talking to Atlas.',
    );
  } else {
    console.log(
      `[storage] local storage at ${dataDir}${mongo.configured ? ' (MONGODB_URI ignored: AMELIA_STORAGE=local)' : ''}`,
    );
  }
  return driver;
}

async function selectDriver(): Promise<StorageDriver> {
  loadEnv();
  const uri = process.env.MONGODB_URI;
  const forced = process.env.AMELIA_STORAGE;

  if (forced === 'local' || !uri) {
    return openLocal({ configured: Boolean(uri), reachable: false }, false);
  }

  try {
    const driver = await createMongoDriver({ uri, serverSelectionTimeoutMs: mongoTimeoutMs() });
    health = {
      driver: 'mongo',
      mongo: { configured: true, reachable: true },
      degraded: false,
      selected_at: new Date().toISOString(),
    };
    console.log('[storage] connected to MongoDB');
    return driver;
  } catch (error) {
    if (forced === 'mongo') throw error;
    return openLocal({ configured: true, reachable: false, error: (error as Error).message }, true);
  }
}

export function getStorage(): Promise<StorageDriver> {
  driverPromise ??= selectDriver().catch((error: unknown) => {
    driverPromise = undefined;
    throw error;
  });
  return driverPromise;
}

/**
 * The health snapshot. Undefined until storage has been opened, which is why
 * the health route should call {@link initStorage} rather than read this cold.
 */
export function storageHealth(): StorageHealth | undefined {
  return health;
}

export async function initStorage(): Promise<StorageHealth> {
  await getStorage();
  return health as StorageHealth;
}

export async function closeStorage(): Promise<void> {
  const pending = driverPromise;
  driverPromise = undefined;
  health = undefined;
  if (!pending) return;
  await pending.then((driver) => driver.close()).catch(() => undefined);
}

/** Point the process at an already-built driver. Tests and `db/migrate.mts` use this. */
export function useStorage(driver: StorageDriver, override?: Partial<StorageHealth>): void {
  driverPromise = Promise.resolve(driver);
  health = {
    driver: driver.kind,
    mongo: { configured: driver.kind === 'mongo', reachable: driver.kind === 'mongo' },
    degraded: false,
    selected_at: new Date().toISOString(),
    ...override,
  };
}
