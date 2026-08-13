import { FAST_PASS_LOOKBACK_TURNS, OWNER_ID } from '../../shared/contracts';
import type { Id, Utterance } from '../../shared/contracts';
import type { AmeliaBus } from '../lib/bus';
import { collections } from './db';
import { extractStructured } from './llm';
import { resolveTonight, todayIsoDate } from './normalize';
import { getPerson, recordFact, recordPromise, resolveFactState } from './store';

/** A turn as the model sees it: the speaker label matters as much as the words. */
interface LabelledTurn {
  utterance_id: Id;
  speaker: string;
  person_id?: Id;
  text: string;
}

async function labelTurns(utterances: Utterance[]): Promise<LabelledTurn[]> {
  const names = new Map<Id, string>();
  for (const personId of new Set(utterances.flatMap((item) => (item.person_id ? [item.person_id] : [])))) {
    const person = await getPerson(personId);
    names.set(personId, person?.name || `Unknown speaker ${personId.slice(-4)}`);
  }
  return utterances.map((utterance) => ({
    utterance_id: utterance._id,
    speaker: utterance.person_id ? (names.get(utterance.person_id) ?? 'Unknown speaker') : 'Unknown speaker',
    ...(utterance.person_id ? { person_id: utterance.person_id } : {}),
    text: utterance.text,
  }));
}

async function lookback(conversationId: Id, throughUtteranceId: Id, turns: number): Promise<Utterance[]> {
  const all = await collections
    .utterances()
    .find({ owner_id: OWNER_ID, conversation_id: conversationId })
    .sort({ start_ms: 1 })
    .toArray();
  const index = all.findIndex((utterance) => utterance._id === throughUtteranceId);
  const end = index === -1 ? all.length : index + 1;
  return all.slice(Math.max(0, end - turns), end);
}

const PROMISE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['promises'],
  properties: {
    promises: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['speaker_person_id', 'source_utterance_id', 'text'],
        properties: {
          speaker_person_id: { type: 'string' },
          source_utterance_id: { type: 'string' },
          text: { type: 'string' },
          due_at: { type: 'string' },
          due_phrase: { type: 'string' },
        },
      },
    },
  },
} as const;

interface PromiseExtraction {
  promises: Array<{
    speaker_person_id: string;
    source_utterance_id: string;
    text: string;
    due_at?: string;
    due_phrase?: string;
  }>;
}

const FAST_PASS_SYSTEM = `You extract commitments from a transcribed conversation.

A promise is a commitment the speaker makes about their own future action. All three must hold:
- first person (the speaker is the one who will act)
- future tense
- a specific object or deliverable

"I'll send you the photos tonight" is a promise. "We should get dinner sometime",
"I think I'll like Oakland", and "I sent it yesterday" are not.

The addressee is whoever raised the topic. If you cannot tell who the promise is to,
skip it rather than guessing.

Resolve relative dates against today's date, given below, and return ISO 8601 in
due_at. Keep the speaker's own wording in due_phrase. Only fill due_at when the
sentence actually carries a time; omit both fields otherwise.

Extract only from the final turn. Earlier turns are context for resolving the
addressee and the referent, not material to extract.

Return {"promises": []} when the final turn contains no commitment. That is the
common case — do not manufacture one.`;

export async function runFastPass(bus: AmeliaBus, utterance: Utterance): Promise<void> {
  const window = await lookback(utterance.conversation_id, utterance._id, FAST_PASS_LOOKBACK_TURNS);
  if (window.length === 0) return;
  const labelled = await labelTurns(window);

  const extraction = await extractStructured<PromiseExtraction>({
    system: FAST_PASS_SYSTEM,
    user: [
      `Today's date is ${todayIsoDate()}. "tonight" resolves to ${resolveTonight()}.`,
      '',
      'Conversation window (final turn is the one to extract from):',
      JSON.stringify(labelled, null, 2),
    ].join('\n'),
    schema: PROMISE_SCHEMA,
    effort: 'low',
  });

  for (const promise of extraction.promises) {
    if (promise.source_utterance_id !== utterance._id) continue;
    await recordPromise(bus, {
      person_id: promise.speaker_person_id,
      source_utterance_id: promise.source_utterance_id,
      text: promise.text,
      ...(promise.due_at ? { due_at: promise.due_at } : {}),
      ...(promise.due_phrase ? { due_phrase: promise.due_phrase } : {}),
    });
  }
}

const FACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['facts'],
  properties: {
    facts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['person_id', 'attribute', 'claim', 'primary_source_utterance_id'],
        properties: {
          person_id: { type: 'string' },
          attribute: {
            type: 'string',
            enum: [
              'name',
              'location',
              'move',
              'job',
              'employer',
              'relationship',
              'preference',
              'project',
              'travel',
              'health',
              'family',
              'note',
            ],
          },
          claim: { type: 'string' },
          primary_source_utterance_id: { type: 'string' },
        },
      },
    },
  },
} as const;

interface FactExtraction {
  facts: Array<{ person_id: string; attribute: string; claim: string; primary_source_utterance_id: string }>;
}

const SLOW_PASS_SYSTEM = `You extract durable facts about people from a transcribed conversation.

A fact is something still true tomorrow: where someone lives, what they do, what
they like, a plan they have. Passing remarks about the current moment are not facts.

A fact about a person is often stated in someone else's sentence. When Jules says
"Maya loves Ethiopian food, and me too", that is two facts — one about Maya, one
about Jules — and both cite Jules's utterance as the source.

Attribute is the slot the claim occupies, chosen from the enum. Two claims share an
attribute only when the newer one could replace the older: a move date and a
different move date share "move"; a food preference and a music preference are both
"preference" but do not replace each other — write the claim so the distinction is
legible.

Write each claim as a standalone sentence naming the person. Cite the utterance the
claim actually came from.`;

const ADJUDICATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['relation', 'reason'],
  properties: {
    relation: { type: 'string', enum: ['replace', 'refine', 'coexist'] },
    reason: { type: 'string' },
  },
} as const;

const ADJUDICATION_SYSTEM = `Two claims share an attribute for the same person. Decide how they relate.

- replace: the new claim states a changed reality — the old one is no longer true.
  A move date pushed from September 1 to September 15 is a replace.
- refine: the new claim is the same reality, stated with more detail. Keep the
  original date the fact was first stated.
- coexist: both are true at once and neither supersedes the other. Two unrelated
  preferences that happen to share the "preference" slot coexist.

When the claims describe the same underlying thing and the new one contradicts the
old, choose replace. Do not choose coexist merely because you are unsure.`;

export async function runSlowPass(bus: AmeliaBus, conversationId: Id): Promise<void> {
  const utterances = await collections
    .utterances()
    .find({ owner_id: OWNER_ID, conversation_id: conversationId })
    .sort({ start_ms: 1 })
    .toArray();
  if (utterances.length === 0) return;
  const labelled = await labelTurns(utterances);

  const extraction = await extractStructured<FactExtraction>({
    system: SLOW_PASS_SYSTEM,
    user: `Conversation:\n${JSON.stringify(labelled, null, 2)}`,
    schema: FACT_SCHEMA,
    effort: 'medium',
  });

  for (const candidate of extraction.facts) {
    const current = await resolveFactState(candidate.person_id, candidate.attribute);
    if (!current) {
      await recordFact(bus, candidate);
      continue;
    }
    if (current.claim_normalized && current.claim === candidate.claim) continue;

    const adjudication = await extractStructured<{ relation: 'replace' | 'refine' | 'coexist'; reason: string }>({
      system: ADJUDICATION_SYSTEM,
      user: [
        `Person: ${candidate.person_id}`,
        `Attribute: ${candidate.attribute}`,
        `Existing claim (stated ${current.valid_from}): ${current.claim}`,
        `New claim: ${candidate.claim}`,
      ].join('\n'),
      schema: ADJUDICATION_SCHEMA,
      effort: 'low',
    });

    if (adjudication.relation === 'coexist') {
      await recordFact(bus, candidate);
      continue;
    }
    await recordFact(bus, {
      ...candidate,
      supersedes: current._id,
      // A refinement restates the same reality, so the chain keeps the date the
      // fact first became true rather than the date it was rephrased.
      ...(adjudication.relation === 'refine' ? { valid_from: current.valid_from } : {}),
    });
  }
}
