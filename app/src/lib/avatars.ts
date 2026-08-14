/**
 * Profile pictures, stored where they survive a reload.
 *
 * The picker hands back a URI inside the app's *cache*, and the only record
 * that a person had a picture lived in the in-memory store. So every reload
 * lost them twice over: the store was rebuilt empty from the server, and the
 * cached file was eligible for deletion anyway.
 *
 * Both problems go away by putting the file at a path derived from the person's
 * id, in the document directory. Nothing has to be persisted about the mapping —
 * the filename *is* the mapping — and there is no server round trip, which
 * matters because an avatar is a local choice about a local file.
 */

import { Directory, File, Paths } from 'expo-file-system';
import type { Id } from '../../../shared/contracts';

const FOLDER = 'avatars';

function folder(): Directory {
  const directory = new Directory(Paths.document, FOLDER);
  if (!directory.exists) directory.create({ intermediates: true });
  return directory;
}

/** Ids are UUIDs, but a person id can be a synthesised label — keep it a filename. */
function fileName(personId: Id): string {
  return `${personId.replace(/[^a-zA-Z0-9_-]/g, '_')}.jpg`;
}

/**
 * Copy a picked image into permanent storage and return its stable URI.
 * Replacing an existing picture overwrites in place, so the id keeps pointing
 * at exactly one file.
 */
export function saveAvatar(personId: Id, sourceUri: string): string {
  const destination = new File(folder(), fileName(personId));
  if (destination.exists) destination.delete();
  new File(sourceUri).copy(destination);
  return destination.uri;
}

/**
 * Every avatar on disk, keyed by person. Read once at startup to rehydrate the
 * store; a handful of small files in one directory.
 */
export function loadAvatars(): Record<Id, string> {
  const avatars: Record<Id, string> = {};
  try {
    for (const entry of folder().list()) {
      if (!(entry instanceof File) || !entry.name.endsWith('.jpg')) continue;
      avatars[entry.name.slice(0, -'.jpg'.length)] = entry.uri;
    }
  } catch {
    // A missing or unreadable directory just means nobody has a picture yet.
  }
  return avatars;
}
