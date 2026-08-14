/**
 * Names a conversation once recording stops.
 *
 * "Conversation, 2:14 PM" tells you nothing, so a list of them is unreadable and
 * you have to open each one to find anything. A short title drawn from what was
 * actually said turns the list into something you can scan.
 *
 * Deliberately cheap and deliberately fallible: it runs once per recording, on a
 * truncated transcript, and any failure leaves the timestamp title in place
 * rather than blocking the end of a session.
 */

import { EXTRACTION_MODEL, type ConversationEvent, type Utterance } from '../../shared/contracts';
import { extractStructured } from './llm';

/** Enough to characterise a conversation; more is spend without more signal. */
const MAX_TURNS = 60;
const MAX_CHARS = 6_000;
/** Below this there is nothing to summarise and a title would be invention. */
const MIN_TURNS = 2;

const TITLE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title'],
  properties: {
    title: {
      type: 'string',
      description: 'Three to six words naming what this conversation was about.',
    },
  },
} as const;

const SYSTEM = [
  'You name conversations for a personal memory app.',
  'Reply with a specific, plain title of three to six words describing what was discussed.',
  'Use sentence case. No quotation marks, no trailing punctuation, no date, no time.',
  'Name the subject, not the format: "Oakland move and venue photos", never "A conversation between friends".',
  'If the transcript is too garbled or thin to characterise, reply exactly: Untitled conversation',
].join(' ');

export interface TitleDeps {
  utterances: { find(filter: object): { toArray(): Promise<Utterance[]> } };
  conversations: {
    updateOne(filter: object, update: object): Promise<unknown>;
  };
  bus: { emit(event: ConversationEvent): void };
  nameFor?(personId: string): string | undefined;
}

/**
 * Build the prompt transcript. Speaker names matter — "Maya: I move on the
 * first" is far more nameable than a wall of anonymous lines.
 */
export function buildTranscript(utterances: Utterance[], nameFor?: (id: string) => string | undefined): string {
  const lines: string[] = []
  let budget = MAX_CHARS
  for (const utterance of utterances.slice(0, MAX_TURNS)) {
    const speaker = (utterance.person_id && nameFor?.(utterance.person_id)) || 'Someone'
    const line = `${speaker}: ${utterance.text.trim()}`
    if (line.length > budget) break
    budget -= line.length
    lines.push(line)
  }
  return lines.join('\n')
}

export async function titleConversation(
  conversationId: string,
  ownerId: string,
  deps: TitleDeps,
): Promise<string | null> {
  const utterances = (await deps.utterances
    .find({ conversation_id: conversationId, owner_id: ownerId })
    .toArray())
    .filter((utterance) => utterance.text.trim().length > 0)
    .sort((a, b) => a.start_ms - b.start_ms)

  if (utterances.length < MIN_TURNS) return null

  const transcript = buildTranscript(utterances, deps.nameFor)
  if (!transcript.trim()) return null

  const { title } = await extractStructured<{ title: string }>({
    system: SYSTEM,
    user: transcript,
    schema: TITLE_SCHEMA as unknown as Record<string, unknown>,
    // The extraction model reasons before it answers, and those tokens count
    // against the cap. 60 was enough for the title and nowhere near enough for
    // the thinking, so every call died on `finish_reason: length`.
    maxTokens: 1_000,
  })

  const clean = title.trim().replace(/^["']|["'.]+$/g, '').slice(0, 80)
  if (!clean || clean.toLowerCase() === 'untitled conversation') return null

  const endedAt = new Date().toISOString()
  await deps.conversations.updateOne(
    { _id: conversationId, owner_id: ownerId },
    { $set: { title: clean, ended_at: endedAt } },
  )
  deps.bus.emit({
    type: 'conversation',
    conversation_id: conversationId,
    title: clean,
    ended_at: endedAt,
  })
  return clean
}

export const TITLE_MODEL = EXTRACTION_MODEL
