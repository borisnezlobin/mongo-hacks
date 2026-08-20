import type { AskRequest, AskResponse, Id, SearchMemoryResult } from '../../shared/contracts';
import {
  extractStructured,
  parseSalvageable,
  TokenCapError,
  type ExtractionRequest,
} from '../memory/llm';
import { getPerson } from '../memory/store';
import { todayIsoDate } from '../memory/normalize';
import { assembleContext, renderContext, type AssembledContext, type Granularity } from './context';
import { searchMemoryScoped } from './retrieval';

const ANSWER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['answer', 'cited_ids'],
  properties: {
    answer: { type: 'string' },
    cited_ids: { type: 'array', items: { type: 'string' } },
  },
} as const;

const ANSWER_SYSTEM = `You answer questions from a personal memory of real conversations.

You are given two kinds of material. Search results are the items that best match
the question. Assembled context is a representative sample of a whole conversation:
a topic strip covering it end to end, and excerpts spread evenly across it, each
line labelled with who said it and carrying the id of the real turn it came from.

Answer only from that material. Attribute anything a person said to that person by
the label shown beside the line — never move a remark to a different speaker, and
never turn "Speaker 2" into a name.

Write the answer as prose a person would say out loud. Ids belong in cited_ids and
nowhere else: never write one in the answer text, in brackets or otherwise.

cited_ids must list the ids you actually used. Every answer that states anything at
all needs at least one. An answer with no citations will be discarded, so if the
material does not cover the question, say so plainly and return no citations rather
than reaching for general knowledge.

The memory is append-only, so claims that have been superseded are filtered out
before you see them — what you are given is current.

Be brief: this is usually read aloud. Two or three sentences for a specific
question. For a question about a whole conversation, name the topics that actually
appear and who raised them, and stay under about six sentences.`;

function renderResults(results: SearchMemoryResult[]): string {
  if (results.length === 0) return '(no matching items)';
  return results
    .map(
      (result, index) =>
        `[${index + 1}] (${result.kind}, id ${result.id}, source utterance ${result.source_utterance_id ?? 'unknown'}) ${result.text}`,
    )
    .join('\n');
}

/**
 * Below this many matched facts, search alone is thin enough that a look at the
 * whole scope is worth its tokens.
 *
 * This is the weaker of retrieval's two thresholds, and a reader should trust
 * it less than the relevance floor in scoring.ts. That floor sits in a
 * 0.17-wide gap with nothing observed inside it; this one sits in an overlap.
 * Sixteen hand-written questions against one seeded conversation gave broad
 * questions at most 2 matched facts and specific ones at least 1, so the honest
 * reading is that 1 and 2 are ambiguous and 3 is the first count that means
 * anything on its own. Both numbers come from a single 38-fact corpus and one
 * embedding model; a second recorded conversation is the thing that would tell
 * us whether either holds.
 *
 * What makes the ambiguity affordable is which way it fails. A question wrongly
 * called broad keeps its search results and gains a view of the scope, so being
 * wrong costs prompt tokens rather than the answer.
 */
const THIN_RESULTS = 3;

/**
 * How wide a sample of the scope to assemble.
 *
 * Decided from what retrieval actually found, not from the shape of the
 * question. Counting query tokens looked reasonable and was not: it routed
 * every one-word question — "Chelsea?", "who's Dhruv" — to an even sample of a
 * whole 48-minute conversation instead of the passage that answers it, while
 * the comment justifying the threshold miscounted both of its own examples.
 *
 * What counts as a hit is the part that had to be measured. Matched *facts*
 * are the signal, not matched turns: a fact is a claim about somebody, so
 * landing on one means the question named something in particular, while any
 * question at all lands on turns — "what did we talk about" matches every turn
 * containing "talk". Over sixteen questions against the seeded conversation the
 * totals did not separate the two kinds at all (broad 0 to 15 hits, specific 2
 * to 22) and fact matches nearly did, which is the whole argument for counting
 * them. See THIN_RESULTS for how far that "nearly" goes.
 */
export function questionBreadth(factMatches: number): Granularity {
  return factMatches < THIN_RESULTS ? 'overview' : 'detail';
}

const OPTIONAL_ASK_IDS = ['person_id', 'conversation_id', 'requester_voiceprint_id'] as const;

/**
 * Say what is wrong with a body before anything tries to read a question out of
 * it, or `null` when nothing is.
 *
 * A body shaped `{"question": "..."}` used to reach the tokenizer and fail
 * there on an undefined string, which reports a caller's typo as a server
 * fault. The name of the field it is missing is the whole of what the caller
 * needs to know.
 */
export function askRequestProblem(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return 'the request body must be a JSON object';
  }
  const fields = body as Record<string, unknown>;
  if (typeof fields.query !== 'string') return 'query is required and must be a string';
  if (fields.query.trim() === '') return 'query must not be empty';
  for (const field of OPTIONAL_ASK_IDS) {
    if (fields[field] !== undefined && typeof fields[field] !== 'string') {
      return `${field} must be a string`;
    }
  }
  return null;
}

export type OwnerVoiceCheck = (voiceprintId: string) => Promise<boolean>;

export interface AnswerDependencies {
  /** Verifies that a voiceprint belongs to the owner. Injected so ask stays testable. */
  verifyOwnerVoice?: OwnerVoiceCheck;
  /** The constrained model call. Injected so grounding can be tested offline. */
  extract?: <T>(request: ExtractionRequest) => Promise<T>;
}

/**
 * Decide whether this asker may read the owner's memory.
 *
 * A request with no `requester_voiceprint_id` came from the app, where holding
 * the unlocked phone is the authentication. A request that carries one came in
 * over a voice channel that anybody in the room can speak into, so it has to be
 * checked — and if we were handed a voiceprint and have no way to check it, the
 * answer is no. `authorized` used to be the literal `true` in both branches,
 * which made the field decorative.
 */
async function authorize(request: AskRequest, deps: AnswerDependencies): Promise<boolean> {
  if (!request.requester_voiceprint_id) return true;
  if (!deps.verifyOwnerVoice) return false;
  try {
    return await deps.verifyOwnerVoice(request.requester_voiceprint_id);
  } catch {
    return false;
  }
}

/**
 * One citation per source.
 *
 * A turn the question matched is often also one of the quotes the context
 * assembled around it, and it can be quoted by two blocks besides, so the same
 * utterance arrived in the list two or three times and the app rendered it that
 * many times. The first copy wins because search results come first and carry a
 * real relevance score, where a context quote is scored zero by construction.
 */
function distinctById(citations: SearchMemoryResult[]): SearchMemoryResult[] {
  const seen = new Set<Id>();
  return citations.filter((citation) => {
    if (seen.has(citation.id)) return false;
    seen.add(citation.id);
    return true;
  });
}

function contextCitations(context: AssembledContext, cited: Set<Id>): SearchMemoryResult[] {
  return context.blocks.flatMap((block) =>
    block.quotes
      .filter((quote) => cited.has(quote.utterance_id))
      .map((quote) => ({
        kind: 'utterance' as const,
        id: quote.utterance_id,
        text: `${quote.speaker}: ${quote.text}`,
        score: 0,
        source_utterance_id: quote.utterance_id,
      })),
  );
}

export const NOTHING_IN_MEMORY = "I don't have anything in memory about that.";

export const ANSWER_CUT_SHORT =
  "I ran out of room part-way through that answer. Ask me for one part of it and I can finish.";

/**
 * What an answer is allowed to cost, and how hard the model may think first.
 *
 * A fact extraction fills a schema; an answer is a few sentences for someone to
 * hear, and measurement says the difference is not where it looks. The reply
 * itself is small — the widest answer measured over twenty questions against
 * the seeded 48-minute conversation was 346 tokens of JSON, six sentences and
 * its citations. The budget goes on the reasoning that precedes it, and at the
 * model's default effort that reasoning is not just larger but unbounded: asked
 * to gather a dozen fact ids it repeats itself, and one run spent 5,613 tokens
 * enumerating the same id over and over before it wrote anything. That is what
 * made a broad question fail against the shared 4,000 cap on some runs and pass
 * on others.
 *
 * At low effort the same twenty questions used 72 to 570 completion tokens with
 * answers of the same length and the same citations, and the repetition stops.
 * Anything from 750 up truncated none of them; 2,000 sits in the middle of that
 * plateau, more than three times the widest run, and is small enough that a run
 * which does start repeating is cut off in a second rather than ten.
 */
const ANSWER_TOKEN_BUDGET = 2_000;
const ANSWER_REASONING_EFFORT = 'low';

/**
 * Keep only citations that point at something real.
 *
 * A model asked for ids will occasionally produce one that looks right and is
 * not, and an answer whose every citation is invented is an answer with nothing
 * behind it. Unverifiable ids are dropped; an answer left with none is replaced
 * outright, because on this product a confident invented claim about a real
 * person costs more than a missed answer.
 */
export function groundAnswer(
  answer: string,
  citedIds: string[],
  citable: Set<Id>,
): { text: string; cited: Set<Id>; grounded: boolean } {
  const cited = new Set(citedIds.filter((id) => citable.has(id)));
  if (cited.size === 0) return { text: NOTHING_IN_MEMORY, cited, grounded: false };
  return { text: withoutInlineIds(answer, citable), cited, grounded: true };
}

/**
 * Take ids back out of the prose.
 *
 * The prompt asks for them in `cited_ids` and the model mostly complies, but it
 * also pastes them mid-sentence — "(fact-f7f6e00b-9666-40ba-b05d-08f63c722503)"
 * — and the answer is read aloud, so a voice spelling out a UUID is the worst
 * form the failure can take. The instruction alone is not enough for something
 * this visible, so the ids are removed as well.
 *
 * Only ids we know are real are removed, and the citation list is unaffected:
 * the reader loses the noise, not the provenance.
 *
 * The brackets left behind have to go with them, and they are not always empty
 * once the id is gone: this model pads its citation markers with zero-width
 * spaces, so stripping the id from `[<zwsp>u-abc<zwsp>]` left a visible `[]`
 * carrying two invisible characters in every broad answer. `\s` does not match
 * a zero-width space, which is why they survived a cleanup that looked like it
 * covered them.
 */
const INVISIBLE = '\\u200b-\\u200d\\ufeff';
const EMPTY_BRACKETS = new RegExp(`[([][\\s,;${INVISIBLE}]*[)\\]]`, 'g');

function withoutInlineIds(answer: string, citable: Set<Id>): string {
  let text = answer;
  for (const id of citable) {
    if (text.includes(id)) text = text.split(id).join('');
  }
  if (text === answer) return answer;
  return text
    .replace(EMPTY_BRACKETS, '')
    .replace(new RegExp(`[${INVISIBLE}]`, 'g'), '')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export async function answerQuestion(
  request: AskRequest,
  deps: AnswerDependencies = {},
): Promise<AskResponse> {
  const requestId = `ask-${crypto.randomUUID()}`;
  const extract = deps.extract ?? extractStructured;

  const authorized = await authorize(request, deps);
  if (!authorized) {
    return {
      request_id: requestId,
      text: 'I can only answer that for the person this memory belongs to.',
      authorized: false,
      citations: [],
    };
  }

  const scope = { conversation_id: request.conversation_id, person_id: request.person_id };
  const results = await searchMemoryScoped(request.query, scope);
  const granularity = questionBreadth(results.filter((result) => result.kind === 'fact').length);

  const wantsContext = granularity === 'overview' || Boolean(request.conversation_id);
  const context = wantsContext
    ? await assembleContext({ ...scope, about: request.query }, { granularity })
    : undefined;

  const citable = new Set<Id>([
    ...results.map((result) => result.id),
    ...(context?.citable_utterance_ids ?? []),
  ]);

  if (citable.size === 0) {
    return { request_id: requestId, text: NOTHING_IN_MEMORY, authorized: true, citations: [] };
  }

  const subject = request.person_id ? await getPerson(request.person_id) : null;
  const cutShort: AskResponse = {
    request_id: requestId,
    text: ANSWER_CUT_SHORT,
    authorized: true,
    citations: [],
  };

  let cutOff = false;
  const answerRequest: ExtractionRequest = {
    system: ANSWER_SYSTEM,
    user: [
      `Today's date is ${todayIsoDate()}.`,
      subject ? `The question is about ${subject.name || 'an unnamed person'}.` : '',
      '',
      `Question: ${request.query}`,
      '',
      'Search results:',
      renderResults(results),
      ...(context ? ['', 'Assembled context:', renderContext(context)] : []),
    ]
      .filter(Boolean)
      .join('\n'),
    schema: ANSWER_SCHEMA,
    maxTokens: ANSWER_TOKEN_BUDGET,
    reasoningEffort: ANSWER_REASONING_EFFORT,
    salvageTruncated: (partial) => {
      cutOff = true;
      return parseSalvageable(partial);
    },
  };

  let extraction: { answer?: string; cited_ids?: string[] };
  try {
    extraction = await extract<{ answer?: string; cited_ids?: string[] }>(answerRequest);
  } catch (error) {
    if (!(error instanceof TokenCapError)) throw error;
    return cutShort;
  }

  // Salvage keeps whole leading fields, so a run cut off early enough leaves no
  // sentence at all. Say that, rather than answering with nothing.
  if (!extraction.answer?.trim()) return cutShort;

  const grounded = groundAnswer(extraction.answer, extraction.cited_ids ?? [], citable);

  // A cut-off run can lose every citation while keeping the sentence, and an
  // answer we cannot stand behind is discarded either way. Which refusal is
  // honest depends on why: there was nothing to say, or no room left to say it.
  if (cutOff && !grounded.grounded) return cutShort;

  return {
    request_id: requestId,
    text: grounded.text,
    authorized: true,
    citations: grounded.grounded
      ? distinctById([
          ...results.filter((result) => grounded.cited.has(result.id)),
          ...(context ? contextCitations(context, grounded.cited) : []),
        ])
      : [],
  };
}
