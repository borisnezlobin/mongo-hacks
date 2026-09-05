/**
 * The two addresses the owner has to be able to change without a rebuild.
 *
 * `EXPO_PUBLIC_API_URL` is inlined at bundle time, and the server moves: a
 * tailnet address, a laptop on someone else's wifi, a cable. Baking the list
 * in and hoping is what makes an unreachable server look from inside the app
 * exactly like an empty account. The glasses host moves for the same reason —
 * the softAP default is one address, and a board on a real network is another.
 *
 * A small JSON file in the document directory, written the way avatars.ts
 * writes files: no server round trip, because this is a local fact about where
 * the server is.
 */

import { Directory, File, Paths } from 'expo-file-system';
import { GLASSES_DEFAULT_HOST } from '../../../shared/contracts';

const FILE_NAME = 'settings.json';

export interface AppSettings {
  /** Base URL of the Amelia server, tried before the bundled candidates. */
  apiBase?: string;
  /** Host or address of the glasses board. */
  glassesHost?: string;
}

let cached: AppSettings | null = null;

function settingsFile(): File {
  const directory = new Directory(Paths.document);
  if (!directory.exists) directory.create({ intermediates: true });
  return new File(directory, FILE_NAME);
}

export function loadSettings(): AppSettings {
  if (cached) return cached;
  try {
    const file = settingsFile();
    cached = file.exists ? (JSON.parse(file.textSync()) as AppSettings) : {};
  } catch {
    // Unreadable or half-written: the app behaves as though nothing was set.
    cached = {};
  }
  return cached;
}

/** Merges and writes. An undefined value clears the key rather than storing null. */
export function saveSettings(update: AppSettings): AppSettings {
  const next: AppSettings = { ...loadSettings(), ...update };
  for (const key of Object.keys(next) as (keyof AppSettings)[]) {
    if (next[key] === undefined || next[key] === '') delete next[key];
  }
  cached = next;
  try {
    settingsFile().write(JSON.stringify(next));
  } catch {
    // The setting still holds for this session; nothing the owner can act on.
  }
  return next;
}

export function savedApiBase(): string | undefined {
  return loadSettings().apiBase;
}

export function savedGlassesHost(): string {
  return loadSettings().glassesHost ?? GLASSES_DEFAULT_HOST;
}

/** Tests and the settings sheet both need to drop what was read from disk. */
export function forgetSettingsCache(): void {
  cached = null;
}
