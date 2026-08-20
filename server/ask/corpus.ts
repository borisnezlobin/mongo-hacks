/**
 * Getting the right turns out of storage, at the size a real corpus reaches.
 *
 * Retrieval used to read the newest 4,000 utterances and score those. One
 * 48-minute recording is ~2,770 turns, so two days of use pushed the first day
 * out of reach entirely and no amount of good ranking could get it back. The
 * fix is not a bigger number: it is only ever loading turns that could plausibly
 * match, which is either
 *
 *   - everything in a named scope (one conversation, or one person), which is
 *     bounded by how long that conversation was rather than by how long the
 *     owner has been recording; or
 *   - everything containing at least one term from the question, fetched
 *     through the inverted index the storage driver already maintains on
 *     `utterances.text`, which is bounded by how rare those words are.
 *
 * Neither is a recency window, so a question about last month is answerable.
 */

import { OWNER_ID } from '../../shared/contracts';
import type { Conversation, Id, Person, Utterance } from '../../shared/contracts';
import { collections } from '../memory/db';
import { buildPassages, indexPassages, type PassageIndex, type PassageUtterance } from './passages';
import { tokenize } from './scoring';

/**
 * Conversations pulled in when a scope names a person but no conversation.
 *
 * Somebody the owner talks to daily would otherwise drag their whole history
 * into one prompt. Five is enough that "what did Mert say" reaches past the
 * last time they spoke, and small enough to stay one bounded read.
 */
export const MAX_SCOPE_CONVERSATIONS = 5;

/**
 * The local driver's inverted index answers a case-insensitive alternation of
 * plain literals without walking the collection; anything else degrades to a
 * scan. Terms are filtered to plain letters and digits so the fast path is
 * always the one taken — but Unicode ones, because an ASCII-only filter threw
 * away every term of a question asked about a Turkish or Ukrainian name and
 * returned "nothing in memory" for a conversation that was full of them.
 *
 * Word boundaries matter as much as the alphabet: unanchored, "cal" matches
 * "physical" and "ai" matches "said", so a two-letter content word pulled the
 * entire corpus into memory to be ranked.
 */
function termPattern(query: string): RegExp | undefined {
  const terms = [...new Set(tokenize(query))].filter((term) => /^[\p{L}\p{N}]+$/u.test(term));
  if (terms.length === 0) return undefined;
  const escaped = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`\\b(?:${escaped.join('|')})\\b`, 'iu');
}

export async function listPeople(): Promise<Person[]> {
  return collections.people().find({ owner_id: OWNER_ID }).toArray();
}

export async function recentConversations(limit: number): Promise<Conversation[]> {
  return collections
    .conversations()
    .find({ owner_id: OWNER_ID })
    .sort({ started_at: -1 })
    .limit(limit)
    .toArray();
}

export async function getConversation(conversationId: Id): Promise<Conversation | null> {
  return collections.conversations().findOne({ _id: conversationId, owner_id: OWNER_ID });
}

export interface UtteranceScope {
  conversation_id?: Id;
  /** Several conversations at once — a date range resolves to one of these. */
  conversation_ids?: Id[];
  person_id?: Id;
}

function conversationFilter(scope: UtteranceScope): Record<string, unknown> {
  if (scope.conversation_ids?.length) return { conversation_id: { $in: scope.conversation_ids } };
  if (scope.conversation_id) return { conversation_id: scope.conversation_id };
  return {};
}

/** True when the caller named which conversations they mean. */
export function namesConversations(scope: UtteranceScope): boolean {
  return Boolean(scope.conversation_id || scope.conversation_ids?.length);
}

/** Every turn in a named scope, oldest first. Bounded by the scope, not by a cap. */
export async function loadScopedUtterances(scope: UtteranceScope): Promise<Utterance[]> {
  const filter = {
    owner_id: OWNER_ID,
    ...conversationFilter(scope),
    ...(scope.person_id ? { person_id: scope.person_id } : {}),
  };
  const utterances = await collections.utterances().find(filter).toArray();
  return utterances.sort((a, b) => a.start_ms - b.start_ms);
}

export async function conversationsBetween(since?: string, until?: string): Promise<Conversation[]> {
  const conversations = await collections.conversations().find({ owner_id: OWNER_ID }).toArray();
  return conversations
    .filter((conversation) => (!since || conversation.started_at >= since) && (!until || conversation.started_at <= until))
    .sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
}

/**
 * Turns that contain at least one word from the question, across the entire
 * corpus and every conversation in it. A question with only stop words in it
 * ("what did we talk about") has no terms to match and gets nothing — that is
 * correct, and it is why coverage assembly exists alongside this.
 */
export async function loadTermMatchedUtterances(query: string, scope: UtteranceScope = {}): Promise<Utterance[]> {
  const pattern = termPattern(query);
  if (!pattern) return [];
  return collections
    .utterances()
    .find({
      owner_id: OWNER_ID,
      ...conversationFilter(scope),
      ...(scope.person_id ? { person_id: scope.person_id } : {}),
      text: { $regex: pattern },
    })
    .toArray();
}

export function toPassageUtterances(utterances: Utterance[]): PassageUtterance[] {
  return utterances.map((utterance) => ({
    id: utterance._id,
    person_id: utterance.person_id,
    text: utterance.text,
    start_ms: utterance.start_ms,
    end_ms: utterance.end_ms,
  }));
}

export interface ScopedCorpus {
  conversation_ids: Id[];
  utterances: Utterance[];
  index: PassageIndex;
}

/**
 * Build the passage view of a scope.
 *
 * Passages are built per conversation and then concatenated, so a passage never
 * straddles two conversations, but the inverse-passage-frequency weights are
 * computed across the whole scope — which is what makes a term "distinctive"
 * relative to everything the answer is allowed to draw on.
 */
export async function loadScopedCorpus(scope: UtteranceScope): Promise<ScopedCorpus> {
  const utterances = await loadScopedUtterances(scope);
  if (utterances.length === 0) return { conversation_ids: [], utterances: [], index: indexPassages([]) };

  const byConversation = new Map<Id, Utterance[]>();
  for (const utterance of utterances) {
    const bucket = byConversation.get(utterance.conversation_id);
    if (bucket) bucket.push(utterance);
    else byConversation.set(utterance.conversation_id, [utterance]);
  }

  const ordered = [...byConversation.entries()].sort(
    (a, b) => (a[1][0]?.start_ms ?? 0) - (b[1][0]?.start_ms ?? 0),
  );
  const kept = namesConversations(scope) ? ordered : ordered.slice(-MAX_SCOPE_CONVERSATIONS);

  const passages = kept.flatMap(([conversationId, turns]) =>
    buildPassages(conversationId, toPassageUtterances(turns)),
  );

  return {
    conversation_ids: kept.map(([conversationId]) => conversationId),
    utterances: kept.flatMap(([, turns]) => turns),
    index: indexPassages(passages),
  };
}
