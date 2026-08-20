import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

/**
 * Tests never touch the real world.
 *
 * Without this, anything that reaches storage tries `MONGODB_URI` first and
 * waits out the connection timeout before falling back — on this network that
 * is several seconds per test file, for a cluster that is never reachable.
 * Worse, the fallback then writes into the developer's real `~/.amelia/data`,
 * so running the suite would quietly mix test fixtures into the people and
 * voiceprints the app has actually learned.
 */
const dataDir = mkdtempSync(join(tmpdir(), 'amelia-test-'));

process.env.AMELIA_STORAGE = 'local';
process.env.AMELIA_DATA_DIR = dataDir;
delete process.env.MONGODB_URI;

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});
