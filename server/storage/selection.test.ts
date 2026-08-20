import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadEnv } from '../memory/env';
import { closeStorage, initStorage, localDataDir, storageHealth } from './index';

// loadEnv() copies the repo's .env into process.env the first time anything
// touches storage. Doing it here means the assignments below are the last word.
loadEnv();

const saved = { ...process.env };
let dataDir: string;

/** Refused instantly rather than after a DNS/TCP timeout, so the test is fast. */
const UNREACHABLE = 'mongodb://127.0.0.1:1/amelia?directConnection=true';

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'amelia-select-'));
  process.env.AMELIA_DATA_DIR = dataDir;
  process.env.AMELIA_MONGO_TIMEOUT_MS = '250';
  delete process.env.MONGODB_URI;
  delete process.env.AMELIA_STORAGE;
});

afterEach(async () => {
  await closeStorage();
  process.env = { ...saved };
  await rm(dataDir, { recursive: true, force: true });
});

describe('choosing a backend', () => {
  it('uses local storage when no cluster is configured, and does not call that degraded', async () => {
    const health = await initStorage();
    expect(health).toMatchObject({
      driver: 'local',
      data_dir: dataDir,
      degraded: false,
      mongo: { configured: false, reachable: false },
    });
  });

  it('falls back to local when the cluster is unreachable, and says so', async () => {
    process.env.MONGODB_URI = UNREACHABLE;
    const health = await initStorage();

    expect(health.driver).toBe('local');
    expect(health.degraded).toBe(true);
    expect(health.mongo.configured).toBe(true);
    expect(health.mongo.reachable).toBe(false);
    expect(health.mongo.error).toBeTruthy();
  });

  it('keeps working after the fallback', async () => {
    process.env.MONGODB_URI = UNREACHABLE;
    await initStorage();
    const { getStorage } = await import('./index');
    const people = (await getStorage()).collection<{ _id: string; name: string }>('people');
    await people.insertOne({ _id: 'p1', name: 'Maya' });
    expect(await people.findOne({ _id: 'p1' })).toMatchObject({ name: 'Maya' });
  });

  it('honours AMELIA_STORAGE=local without probing the cluster at all', async () => {
    process.env.MONGODB_URI = UNREACHABLE;
    process.env.AMELIA_STORAGE = 'local';
    const started = Date.now();
    const health = await initStorage();

    expect(health.driver).toBe('local');
    expect(health.degraded).toBe(false);
    expect(Date.now() - started).toBeLessThan(250);
  });

  it('fails loudly rather than falling back when Mongo was demanded explicitly', async () => {
    process.env.MONGODB_URI = UNREACHABLE;
    process.env.AMELIA_STORAGE = 'mongo';
    await expect(initStorage()).rejects.toThrow();
  });

  it('reports nothing until storage has been opened', () => {
    expect(storageHealth()).toBeUndefined();
  });

  it('resolves the data directory from AMELIA_DATA_DIR', () => {
    expect(localDataDir()).toBe(dataDir);
  });

  it('defaults the data directory outside the repository', () => {
    delete process.env.AMELIA_DATA_DIR;
    expect(localDataDir()).toMatch(/\.amelia\/data$/);
    expect(localDataDir()).not.toContain('mongo-hacks');
  });

  it('opens the driver once even when several callers race', async () => {
    const { getStorage } = await import('./index');
    const drivers = await Promise.all([getStorage(), getStorage(), getStorage()]);
    expect(new Set(drivers).size).toBe(1);
  });
});
