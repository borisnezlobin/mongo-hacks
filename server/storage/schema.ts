/**
 * What the local driver indexes, mirroring db/indexes.json.
 *
 * Unique indexes are load-bearing: `insertIdempotent` relies on a duplicate-key
 * error to detect a replayed extraction, so the local driver has to enforce the
 * same two uniqueness constraints Atlas does.
 */

export interface CollectionSchema {
  name: string;
  /** Enforced on write; a violation throws a 11000-coded DuplicateKeyError. */
  uniqueIndexes?: Array<{ name: string; keys: string[] }>;
  /** Single fields hashed for candidate narrowing. The planner picks the smallest bucket. */
  equalityIndexes?: string[];
  /** Fields tokenised into an inverted index so substring scans skip the corpus. */
  textIndexes?: string[];
}

export const COLLECTION_NAMES = [
  'people',
  'voiceprints',
  'conversations',
  'utterances',
  'facts',
  'promises',
  'reminders',
] as const;

export type CollectionName = (typeof COLLECTION_NAMES)[number];

export const SCHEMA: CollectionSchema[] = [
  { name: 'people', equalityIndexes: ['owner_id', 'is_owner'] },
  { name: 'voiceprints', equalityIndexes: ['person_id', 'source_conversation_id'] },
  { name: 'conversations', equalityIndexes: ['owner_id'] },
  {
    name: 'utterances',
    equalityIndexes: ['conversation_id', 'person_id'],
    textIndexes: ['text'],
  },
  {
    name: 'facts',
    uniqueIndexes: [
      { name: 'facts_idempotency', keys: ['owner_id', 'primary_source_utterance_id', 'claim_normalized'] },
    ],
    equalityIndexes: ['person_id', 'attribute', 'superseded_by', 'primary_source_utterance_id'],
    textIndexes: ['claim', 'attribute'],
  },
  {
    name: 'promises',
    uniqueIndexes: [
      { name: 'promises_idempotency', keys: ['owner_id', 'source_utterance_id', 'text_normalized'] },
    ],
    equalityIndexes: ['person_id', 'status', 'source_utterance_id'],
    textIndexes: ['text'],
  },
  { name: 'reminders', equalityIndexes: ['promise_id', 'status'] },
];

export function schemaFor(name: string): CollectionSchema {
  return SCHEMA.find((entry) => entry.name === name) ?? { name };
}
