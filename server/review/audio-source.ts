/**
 * Where the wav for a conversation lives.
 *
 * There is no recording path on the conversation record, so this is convention:
 * `<conversation_id>.wav` in one of the places recordings actually land. The id
 * is used as a filename, so it is validated rather than trusted — a
 * conversation_id is attacker-controlled in the sense that anything can POST
 * one, and this endpoint reads files off the owner's laptop.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isSafeConversationId(id: string): boolean {
  return SAFE_ID.test(id) && !id.includes('..');
}

function dataDir(): string {
  const configured = process.env.AMELIA_DATA_DIR;
  if (configured) return isAbsolute(configured) ? configured : resolve(repoRoot, configured);
  return join(homedir(), '.amelia', 'data');
}

export function audioSearchDirs(): string[] {
  const dirs: string[] = [];
  if (process.env.AMELIA_REVIEW_AUDIO_DIR) dirs.push(resolve(process.env.AMELIA_REVIEW_AUDIO_DIR));
  dirs.push(join(repoRoot, 'fixtures', 'real'));
  dirs.push(join(dataDir(), 'recordings'));
  dirs.push(dataDir());
  dirs.push(join(repoRoot, '.recordings'));
  return dirs;
}

export function findConversationAudio(conversationId: string): string | null {
  if (!isSafeConversationId(conversationId)) return null;
  for (const dir of audioSearchDirs()) {
    const candidate = join(dir, `${conversationId}.wav`);
    // The id is already restricted to a safe alphabet, but a resolve check
    // makes the containment guarantee independent of that regex staying right.
    if (resolve(candidate).startsWith(resolve(dir)) && existsSync(candidate)) return candidate;
  }
  return null;
}
