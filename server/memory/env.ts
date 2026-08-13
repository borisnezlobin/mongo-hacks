import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The DOM lib is on for the Expo side, and its global URL is not the one
// node:fs accepts — resolve to plain path strings instead.
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The frozen server scaffold does not load dotenv and Lane B must not edit it,
 * so every entry point that reads a secret loads the file itself. This must not
 * hang off the Mongo client: scripts that only talk to Fireworks need it too.
 *
 * The repo-root file is read first and `server/.env` second, so the more
 * specific file wins. A missing file is fine — CI and the venue laptops may
 * carry the variables in the ambient environment instead.
 */
let loadedFrom: string[] | undefined;

/** Returns the files it actually read, so scripts can say where a value came from. */
export function loadEnv(): string[] {
  if (loadedFrom) return loadedFrom;
  loadedFrom = [];
  for (const relative of ['../../.env', '../.env']) {
    const path = join(HERE, relative);
    try {
      process.loadEnvFile(path);
      loadedFrom.push(path);
    } catch {
      /* absent or unreadable — fall through to the ambient environment */
    }
  }
  return loadedFrom;
}

export function requireEnv(name: string): string {
  loadEnv();
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required (see server/.env.example)`);
  return value;
}
