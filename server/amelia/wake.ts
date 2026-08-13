import { OWNER_AUTH_THRESHOLD, OWNER_ID, type UtteranceEvent } from '../../shared/contracts';

/** Matched case- and punctuation-insensitively. */
export const WAKE_PHRASE = 'hey amelia';

/** Strip punctuation and collapse whitespace so "Hey, Amelia —" still matches. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface WakeMatch {
  command: string;
  utterance_id: string;
  conversation_id: string;
}

/**
 * Returns the command if this finalized turn is an owner-authorized summon.
 *
 * Two gates, both required:
 *   1. the turn contains the wake phrase
 *   2. the speaker is the owner at OWNER_AUTH_THRESHOLD — the LOOSE threshold.
 *      Strict attribution (ATTRIBUTION_THRESHOLD) is Lane A's and is not used here.
 *
 * `ownerConfidence` comes from Lane A's identity pass. Undefined ⇒ we fail
 * CLOSED: an unauthenticated wake is not a summon. The press-and-hold route is
 * the deliberate bypass for a failed voice match on stage.
 */
export function detectWake(u: UtteranceEvent, ownerConfidence?: number): WakeMatch | null {
  if (!u.is_final) return null;
  if (normalize(u.text).indexOf(WAKE_PHRASE) === -1) return null;
  if (u.person_id !== OWNER_ID) return null;
  if (ownerConfidence === undefined || ownerConfidence < OWNER_AUTH_THRESHOLD) return null;

  // Command = wake phrase → end of turn. Slice the ORIGINAL text so casing and
  // punctuation survive into the prompt.
  //
  // Map each normalized word back to a character offset rather than counting
  // words in both strings: a bare punctuation token ("--") is a word in the
  // original but vanishes under normalize(), so the two counts drift apart and
  // the slice lands mid-command.
  const words: { word: string; end: number }[] = [];
  for (const m of u.text.matchAll(/\S+/g)) {
    const end = m.index + m[0].length;
    for (const part of normalize(m[0]).split(' ')) {
      if (part) words.push({ word: part, end });
    }
  }

  const wake = WAKE_PHRASE.split(' ');
  let cut = -1;
  for (let i = 0; i + wake.length <= words.length; i++) {
    if (wake.every((w, k) => words[i + k]!.word === w)) {
      cut = words[i + wake.length - 1]!.end;
      break;
    }
  }
  if (cut === -1) return null;

  // Drop punctuation that trailed the wake phrase ("Hey Amelia, …").
  const command = u.text.slice(cut).replace(/^[^\p{L}\p{N}]+/u, '').trim();
  if (!command) return null;

  return { command, utterance_id: u.utterance_id, conversation_id: u.conversation_id };
}
