/**
 * Assembling a bounded, speaker-attributed view of a scope.
 *
 * Relevance ranking answers "find me the line about X". It cannot answer "what
 * did we talk about", because a question like that has no discriminating words
 * in it — every term is a stop word — and even when it does, the top ten hits
 * come from the same four minutes and the other forty-four are never seen.
 *
 * So this is the other half of retrieval: given a scope and a budget, return
 * something *representative* of the scope. Coverage across the whole timeline
 * comes first; relevance decides what gets picked within each part of it. Every
 * line carries the speaker and the real utterance id, so attribution and
 * citations survive the reduction.
 *
 * There is no model in this path. Reduction is selection and truncation, not
 * paraphrase, which is why nothing here can invent a topic or move a sentence
 * from one speaker's mouth to another's.
 */

import type { Conversation, Id, Utterance } from '../../shared/contracts';
import { embedDocuments, embedQuery } from '../memory/embeddings';
import {
  conversationsBetween,
  getConversation,
  listPeople,
  loadScopedCorpus,
  MAX_SCOPE_CONVERSATIONS,
  namesConversations,
  recentConversations,
  type UtteranceScope,
} from './corpus';
import {
  bucketPassages,
  distinctiveTerms,
  representativeUtterances,
  selectRepresentative,
  type Passage,
  type PassageIndex,
} from './passages';
import { bm25, cosine, fuseByRank, tokenize, type ScoredDocument } from './scoring';
import { labelSpeakers, type SpeakerLabels } from './speakers';

export type Granularity = 'overview' | 'detail' | 'verbatim';

export interface ContextScope extends UtteranceScope {
  /** Optional focus. Steers which passage is picked, never whether a span appears. */
  about?: string;
  /** ISO bounds on when the conversation started. */
  since?: string;
  until?: string;
}

export interface ContextOptions {
  granularity?: Granularity;
  /** Rough words of transcript to spend. Honoured, not exceeded by much. */
  budget_words?: number;
}

export interface ContextQuote {
  utterance_id: Id;
  speaker: string;
  at: string;
  text: string;
}

export interface ContextBlock {
  passage_id: string;
  conversation_id: Id;
  at: string;
  speakers: string[];
  topics: string[];
  quotes: ContextQuote[];
}

export interface TimelineEntry {
  at: string;
  speakers: string[];
  topics: string[];
}

export interface ContextConversation {
  id: Id;
  title?: string;
  started_at?: string;
  speakers: string[];
  utterances: number;
}

export interface AssembledContext {
  conversations: ContextConversation[];
  /** Topic strip over the WHOLE scope, so nothing is silently out of view. */
  timeline: TimelineEntry[];
  blocks: ContextBlock[];
  coverage: { passages: number; passages_quoted: number; quoted_words: number };
  /** Every id an answer may cite. */
  citable_utterance_ids: Id[];
  note?: string;
}

/**
 * Budgets, in words of quoted transcript.
 *
 * Sized against the 48-minute fixture, which is 11,925 words in 95 passages. An
 * overview spends ~500 of those words across the timeline plus a topic strip,
 * landing near 1,500 prompt tokens — enough for a model to give a fair account
 * of the whole conversation, small enough to leave room for the rest of an
 * agent's context.
 *
 * The budget is deliberately absolute rather than a fraction of the corpus, so
 * a four-hour recording costs the same as a ten-minute one and the reduction
 * loses resolution instead of losing the end of the conversation. What that
 * buys is worth stating plainly: an overview of this recording quotes 16
 * passages out of 95, so it is a fair sample and never a transcript.
 */
const GRANULARITY: Record<Granularity, { budget_words: number; words_per_passage: number; timeline: boolean }> = {
  overview: { budget_words: 500, words_per_passage: 30, timeline: true },
  detail: { budget_words: 900, words_per_passage: 90, timeline: true },
  verbatim: { budget_words: 900, words_per_passage: 400, timeline: false },
};

/** Topic strip length. Constant, so a four-hour recording costs what a ten-minute one does. */
const TIMELINE_ENTRIES = 24;

/**
 * Passages embedded for one question. Beyond this the scope is sampled evenly
 * before embedding, so the semantic leg loses resolution rather than losing the
 * back half of the corpus.
 */
const SEMANTIC_PASSAGE_CAP = 128;

export function formatOffset(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1_000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

const vectorCache = new Map<string, number[]>();
const VECTOR_CACHE_LIMIT = 4_000;

/** Tests need a cold cache; nothing in the server calls this. */
export function clearPassageVectorCache(): void {
  vectorCache.clear();
}

function cacheKey(text: string): string {
  let hash = 5_381;
  for (let position = 0; position < text.length; position += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(position)) | 0;
  }
  return `${text.length}:${hash}`;
}

function remember(text: string, vector: number[]): void {
  if (vectorCache.size >= VECTOR_CACHE_LIMIT) {
    const oldest = vectorCache.keys().next().value;
    if (oldest !== undefined) vectorCache.delete(oldest);
  }
  vectorCache.set(cacheKey(text), vector);
}

/**
 * Passage vectors, computed once and kept.
 *
 * Utterances are stored without embeddings and there are thousands of them, so
 * embedding the transcript per question is not an option. Passages are two
 * orders of magnitude fewer, they are the unit selection works on anyway, and
 * caching them by content means a second question about the same conversation
 * costs no embedding calls at all.
 */
async function passageVectors(passages: Passage[]): Promise<Map<string, number[]>> {
  const vectors = new Map<string, number[]>();
  const missing: Passage[] = [];

  for (const passage of passages) {
    const cached = vectorCache.get(cacheKey(passage.text));
    if (cached) vectors.set(passage.id, cached);
    else missing.push(passage);
  }

  if (missing.length > 0) {
    const computed = await embedDocuments(missing.map((passage) => passage.text));
    if (!Array.isArray(computed) || computed.length !== missing.length) return vectors;
    missing.forEach((passage, position) => {
      const vector = computed[position];
      if (!vector?.length) return;
      remember(passage.text, vector);
      vectors.set(passage.id, vector);
    });
  }

  return vectors;
}

function evenSample(index: PassageIndex, limit: number): Passage[] {
  if (index.passages.length <= limit) return index.passages;
  return selectRepresentative(index, { slots: limit });
}

/**
 * Where in the scope the question points, fused from words and meaning.
 *
 * The lexical leg finds the passage that uses the asker's words; the semantic
 * leg finds the passage that is about the same thing in different words, which
 * is most of them. An embeddings outage drops the second leg and keeps the
 * first, because a lexical-only answer beats a failed question.
 */
async function focusScores(query: string, index: PassageIndex): Promise<Map<string, number>> {
  if (tokenize(query).length === 0 || index.passages.length === 0) return new Map();

  const documents: ScoredDocument[] = index.passages.map((passage) => ({ id: passage.id, text: passage.text }));
  const lexical = bm25(query, documents);

  let semantic = new Map<string, number>();
  try {
    const [queryVector, vectors] = await Promise.all([
      embedQuery(query),
      passageVectors(evenSample(index, SEMANTIC_PASSAGE_CAP)),
    ]);
    if (Array.isArray(queryVector) && queryVector.length > 0) {
      semantic = new Map([...vectors].map(([id, vector]) => [id, cosine(queryVector, vector)]));
    }
  } catch (error) {
    console.warn('[ask] passage embeddings unavailable, focusing lexically:', (error as Error).message);
  }

  return fuseByRank([lexical, semantic]);
}

function conversationSummaries(
  utterances: Utterance[],
  conversations: Map<Id, Conversation | null>,
  speakers: SpeakerLabels,
): ContextConversation[] {
  const grouped = new Map<Id, Utterance[]>();
  for (const utterance of utterances) {
    const bucket = grouped.get(utterance.conversation_id);
    if (bucket) bucket.push(utterance);
    else grouped.set(utterance.conversation_id, [utterance]);
  }

  return [...grouped.entries()].map(([id, turns]) => {
    const present: string[] = [];
    for (const turn of turns) {
      const label = speakers.label(turn.person_id);
      if (!present.includes(label)) present.push(label);
    }
    const conversation = conversations.get(id);
    return {
      id,
      title: conversation?.title,
      started_at: conversation?.started_at,
      speakers: present,
      utterances: turns.length,
    };
  });
}

function buildTimeline(index: PassageIndex, speakers: SpeakerLabels): TimelineEntry[] {
  return bucketPassages(index.passages, TIMELINE_ENTRIES).map((bucket) => {
    const topics: string[] = [];
    const present: string[] = [];
    for (const passage of bucket) {
      for (const term of distinctiveTerms(passage, index, 3)) {
        if (!topics.includes(term)) topics.push(term);
      }
      for (const personId of passage.speaker_ids) {
        const label = speakers.label(personId);
        if (!present.includes(label)) present.push(label);
      }
    }
    return {
      at: formatOffset(bucket[0]?.start_ms ?? 0),
      speakers: present,
      topics: topics.slice(0, 6),
    };
  });
}

/**
 * Resolve a scope that names nothing.
 *
 * A spoken question with no scope is almost always about the conversation the
 * owner just had, so an empty scope means the most recent conversation rather
 * than the entire corpus. It is a default, not a restriction: the caller can
 * always name a conversation, a person, or both.
 */
async function resolveScope(scope: ContextScope): Promise<UtteranceScope> {
  if (namesConversations(scope)) {
    return {
      conversation_id: scope.conversation_id,
      conversation_ids: scope.conversation_ids,
      person_id: scope.person_id,
    };
  }

  if (scope.since || scope.until) {
    const within = await conversationsBetween(scope.since, scope.until);
    return {
      conversation_ids: within.slice(0, MAX_SCOPE_CONVERSATIONS).map((conversation) => conversation._id),
      person_id: scope.person_id,
    };
  }

  if (scope.person_id) return { person_id: scope.person_id };

  const [latest] = await recentConversations(1);
  return latest ? { conversation_id: latest._id } : {};
}

export async function assembleContext(
  scope: ContextScope = {},
  options: ContextOptions = {},
): Promise<AssembledContext> {
  const granularity = options.granularity ?? 'overview';
  const preset = GRANULARITY[granularity] ?? GRANULARITY.overview;
  const budget = Math.max(60, options.budget_words ?? preset.budget_words);

  const resolved = await resolveScope(scope);
  const empty: AssembledContext = {
    conversations: [],
    timeline: [],
    blocks: [],
    coverage: { passages: 0, passages_quoted: 0, quoted_words: 0 },
    citable_utterance_ids: [],
    note: 'Nothing is recorded in this scope.',
  };
  if (!namesConversations(resolved) && !resolved.person_id) return empty;

  const corpus = await loadScopedCorpus(resolved);
  if (corpus.index.passages.length === 0) return empty;

  const people = await listPeople();
  const speakers = labelSpeakers(corpus.utterances, people);

  const focus = scope.about ? await focusScores(scope.about, corpus.index) : undefined;
  const slots = Math.max(1, Math.floor(budget / preset.words_per_passage));
  const selected = selectRepresentative(corpus.index, { slots, focus });

  let quotedWords = 0;
  const blocks: ContextBlock[] = selected.map((passage) => {
    const remaining = Math.max(0, budget - quotedWords);
    const allowance = Math.min(preset.words_per_passage, Math.max(10, remaining));
    const quotes = representativeUtterances(passage, corpus.index, allowance);
    quotedWords += quotes.reduce((total, quote) => total + quote.text.trim().split(/\s+/).length, 0);
    return {
      passage_id: passage.id,
      conversation_id: passage.conversation_id,
      at: formatOffset(passage.start_ms),
      speakers: passage.speaker_ids.map((personId) => speakers.label(personId)),
      topics: distinctiveTerms(passage, corpus.index, 4),
      quotes: quotes.map((quote) => ({
        utterance_id: quote.id,
        speaker: speakers.label(quote.person_id),
        at: formatOffset(quote.start_ms),
        text: quote.text.trim(),
      })),
    };
  });

  const conversations = await Promise.all(
    corpus.conversation_ids.map(async (id) => [id, await getConversation(id)] as const),
  );

  return {
    conversations: conversationSummaries(corpus.utterances, new Map(conversations), speakers),
    timeline: preset.timeline ? buildTimeline(corpus.index, speakers) : [],
    blocks,
    coverage: {
      passages: corpus.index.passages.length,
      passages_quoted: blocks.length,
      quoted_words: quotedWords,
    },
    citable_utterance_ids: blocks.flatMap((block) => block.quotes.map((quote) => quote.utterance_id)),
  };
}

/** The same context as plain text, for a prompt. Compact on purpose. */
export function renderContext(context: AssembledContext): string {
  const lines: string[] = [];

  /**
   * Until voices are resolved to people, a long recording can hold dozens of
   * separate speaker clusters, and listing all of them costs more tokens than
   * it tells anybody.
   */
  const roster = (speakers: string[]) =>
    speakers.length <= 12
      ? speakers.join(', ')
      : `${speakers.slice(0, 12).join(', ')} and ${speakers.length - 12} more`;

  for (const conversation of context.conversations) {
    lines.push(
      `Conversation ${conversation.id}${conversation.title ? ` "${conversation.title}"` : ''}` +
        `${conversation.started_at ? ` started ${conversation.started_at}` : ''}` +
        ` — ${conversation.utterances} turns, speakers: ${roster(conversation.speakers) || 'none identified'}`,
    );
  }

  if (context.timeline.length > 0) {
    lines.push('', 'Topics across the whole conversation, in order:');
    for (const entry of context.timeline) {
      lines.push(`  ${entry.at} ${entry.topics.join(', ') || '(no distinctive words)'} [${entry.speakers.join(', ')}]`);
    }
  }

  if (context.blocks.length > 0) {
    lines.push('', 'Representative excerpts, evenly spread across the scope:');
    for (const block of context.blocks) {
      lines.push(`  ${block.at} — ${block.topics.join(', ')}`);
      for (const quote of block.quotes) {
        lines.push(`    (id ${quote.utterance_id}) ${quote.speaker}: ${quote.text}`);
      }
    }
  }

  if (context.note) lines.push('', context.note);
  return lines.join('\n');
}
