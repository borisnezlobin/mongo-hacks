import type { AskRequest, AskResponse, SearchMemoryResult } from '../../shared/contracts';
import { extractStructured } from '../memory/llm';
import { getPerson } from '../memory/store';
import { todayIsoDate } from '../memory/normalize';
import { searchMemory } from './retrieval';

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

Every retrieved item carries the id of the utterance it came from and the date it
was stated. Answer only from those items, and list in cited_ids the ids of the ones
you actually used.

The memory is append-only, so a claim that has been superseded is already filtered
out before you see it — what you are given is current. Say so plainly rather than
hedging about what might have changed.

When the memory does not cover the question, say that directly and leave cited_ids
empty. Do not fill the gap from general knowledge.

Answer in one or two sentences. Mention when something was said only when the date
is part of the answer.`;

function renderResults(results: SearchMemoryResult[]): string {
  return results
    .map(
      (result, index) =>
        `[${index + 1}] (${result.kind}, id ${result.id}, source utterance ${result.source_utterance_id ?? 'unknown'}) ${result.text}`,
    )
    .join('\n');
}

export async function answerQuestion(request: AskRequest): Promise<AskResponse> {
  const requestId = `ask-${crypto.randomUUID()}`;
  const results = await searchMemory(request.query, request.person_id);

  if (results.length === 0) {
    return {
      request_id: requestId,
      text: 'I have nothing in memory about that yet.',
      authorized: true,
      citations: [],
    };
  }

  const subject = request.person_id ? await getPerson(request.person_id) : null;
  const extraction = await extractStructured<{ answer: string; cited_ids: string[] }>({
    system: ANSWER_SYSTEM,
    user: [
      `Today's date is ${todayIsoDate()}.`,
      subject ? `The question is about ${subject.name || 'an unnamed person'}.` : '',
      '',
      `Question: ${request.query}`,
      '',
      'Retrieved memory:',
      renderResults(results),
    ]
      .filter(Boolean)
      .join('\n'),
    schema: ANSWER_SCHEMA,
    effort: 'medium',
  });

  const cited = new Set(extraction.cited_ids);
  return {
    request_id: requestId,
    text: extraction.answer,
    authorized: true,
    citations: results.filter((result) => cited.has(result.id)),
  };
}
