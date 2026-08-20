/**
 * Amelia's tool surface.
 *
 * Deliberately general. There is no tool for summarising a conversation, no
 * tool for listing what somebody said, no tool per question shape — those are
 * all the same operation with different arguments: name a scope, choose a
 * granularity, spend a budget. A tool per phrasing answers exactly the phrasing
 * it was written for and nothing near it.
 *
 * Five tools bind to Lane B's frozen MemoryApi; `draft_email` is Lane D's own.
 * The retrieval tools read through Lane B's `server/ask` surface. Lane D never
 * writes Lane B's collections directly.
 */

import { TONIGHT_DEFAULT_HOUR, type MemoryApi } from '../../shared/contracts';
import { assembleContext, type ContextOptions, type ContextScope } from '../ask/context';
import { listPeople, recentConversations } from '../ask/corpus';
import type { ToolSpec } from './provider';
import { draftEmail } from './email';

/**
 * Descriptions are prescriptive about WHEN to call, not just what the tool
 * does — Opus-tier models reach for tools conservatively otherwise.
 */
export const TOOLS: ToolSpec[] = [
  {
    name: 'search_memory',
    description:
      "Search everything Amelia has recorded about the people in the owner's life. " +
      'Call this first whenever the request depends on something a person said — a trip, ' +
      'a job, a preference, a plan. Pass person_id to scope the search when you already ' +
      'know who is meant.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you are looking for, in plain language.' },
        person_id: { type: 'string', description: 'Optional. Restrict to one person.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'gather_context',
    description:
      'Read a representative sample of what was actually said, with every line labelled ' +
      'by speaker and carrying the id of the real turn. Use this whenever the question is ' +
      'about a stretch of conversation rather than one detail — what was discussed, who ' +
      'was there, what somebody spent the evening talking about — and use it when ' +
      'search_memory comes back thin.\n' +
      'Scope it: conversation_id for one conversation, person_id for one person (their ' +
      'own words only), since/until for a date range, or nothing at all for the most ' +
      'recent conversation. about steers which parts come back; leave it empty for an ' +
      'even sample.\n' +
      'granularity: "overview" samples the whole scope thinly and adds a topic strip ' +
      'covering it end to end — the right choice for a broad question about a long ' +
      'conversation. "detail" quotes fewer places at more length. "verbatim" returns ' +
      'long unbroken excerpts and should be scoped narrowly.\n' +
      'The excerpts are a sample, not the transcript. Say what the material supports and ' +
      'nothing beyond it.',
    parameters: {
      type: 'object',
      properties: {
        conversation_id: { type: 'string' },
        person_id: { type: 'string', description: 'Restrict to what this person said themselves.' },
        since: { type: 'string', description: 'ISO 8601 date or timestamp.' },
        until: { type: 'string', description: 'ISO 8601 date or timestamp.' },
        about: { type: 'string', description: 'Optional focus, in plain language.' },
        granularity: { type: 'string', enum: ['overview', 'detail', 'verbatim'] },
        budget_words: { type: 'number', description: 'Roughly how many words of transcript to spend.' },
      },
      required: [],
    },
  },
  {
    name: 'list_conversations',
    description:
      'List recent conversations — when each happened, how many turns, and who spoke. ' +
      'Call this to find the conversation a question refers to before scoping ' +
      'gather_context to it, or to answer questions about when something happened.',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Default 10.' } },
      required: [],
    },
  },
  {
    name: 'list_people',
    description:
      'List everyone in the memory, named and unnamed. Call this to turn a name in the ' +
      'request into a person_id. Voices that have not been named yet appear as unnamed — ' +
      'never guess which person an unnamed voice is.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_person',
    description:
      'Look up one person by id. Call this to turn a name in the request into a person_id ' +
      'before scoping other calls, or to read their details.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'resolve_fact_state',
    description:
      'Get the CURRENT value of one attribute for one person. Call this when a fact could ' +
      'have changed over time — a date, an address, a plan — before acting on it, because ' +
      'a search hit may be a value the person has since revised.\n' +
      'Attributes are SHORT SINGLE WORDS from a small controlled vocabulary, currently: ' +
      'move, job, name, preference, project, email. Use one of those exactly. ' +
      'Multi-word guesses like "move_date" or "move in date" do not exist and will return ' +
      'nothing. If the attribute you want is not in that list, do not guess variations — ' +
      'answer from the search results instead.',
    parameters: {
      type: 'object',
      properties: {
        person_id: { type: 'string' },
        attribute: {
          type: 'string',
          description: 'One short lowercase word, e.g. "move", "job", "preference", "email".',
        },
      },
      required: ['person_id', 'attribute'],
    },
  },
  {
    name: 'draft_email',
    description:
      'Compose an email DRAFT for the owner to review. Call this when the request asks to ' +
      'write, send, or reach out to someone by email. The draft is shown in the app and is ' +
      "never sent automatically. Write in the owner's voice: plain sentences, no preamble, " +
      'no signature block.',
    parameters: {
      type: 'object',
      properties: {
        to_person_id: { type: 'string' },
        subject: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['to_person_id', 'subject', 'body'],
    },
  },
  {
    name: 'create_reminder',
    description:
      'Schedule a reminder against a promise made in conversation. Call this when the ' +
      'request asks to be reminded or to follow up at a specific time. Resolve relative ' +
      `phrasing before calling: "tonight" means ${TONIGHT_DEFAULT_HOUR}:00 today.`,
    parameters: {
      type: 'object',
      properties: {
        promise_id: { type: 'string' },
        fire_at: { type: 'string', description: 'Absolute ISO 8601 timestamp.' },
      },
      required: ['promise_id', 'fire_at'],
    },
  },
  {
    name: 'add_note',
    description:
      'Attach a note to a person. Call this when the owner states something about someone ' +
      'that should be remembered but is not a promise or a dated fact.',
    parameters: {
      type: 'object',
      properties: { person_id: { type: 'string' }, text: { type: 'string' } },
      required: ['person_id', 'text'],
    },
  },
];

export interface ToolOutcome {
  /** JSON payload returned to the model. */
  result: unknown;
  /** Mongo-flavoured copy for the amelia_step stream. */
  message: string;
  isError?: boolean;
}

/**
 * The read side of memory, injected so the tool layer can be exercised without
 * storage. `MemoryApi` is frozen and has no room for scope or granularity, so
 * these come from Lane B's retrieval surface rather than through it.
 */
export interface RetrievalTools {
  assembleContext(scope: ContextScope, options: ContextOptions): ReturnType<typeof assembleContext>;
  recentConversations(limit: number): ReturnType<typeof recentConversations>;
  listPeople(): ReturnType<typeof listPeople>;
}

const LIVE_RETRIEVAL: RetrievalTools = { assembleContext, recentConversations, listPeople };

function describePerson(person: { name?: string; is_unnamed?: boolean; is_owner?: boolean }): string {
  if (person.is_owner) return 'you';
  if (person.is_unnamed || !person.name?.trim()) return 'an unnamed voice';
  return person.name;
}

export async function runTool(
  memory: MemoryApi,
  name: string,
  input: Record<string, any>,
  retrieval: RetrievalTools = LIVE_RETRIEVAL,
): Promise<ToolOutcome> {
  try {
    switch (name) {
      case 'gather_context': {
        const context = await retrieval.assembleContext(
          {
            conversation_id: input.conversation_id,
            person_id: input.person_id,
            since: input.since,
            until: input.until,
            about: input.about,
          },
          { granularity: input.granularity, budget_words: input.budget_words },
        );

        const result = {
          conversations: context.conversations,
          coverage: context.coverage,
          topics_over_time: context.timeline,
          excerpts: context.blocks.map((block) => ({
            at: block.at,
            conversation_id: block.conversation_id,
            topics: block.topics,
            lines: block.quotes.map((quote) => `(id ${quote.utterance_id}) ${quote.speaker}: ${quote.text}`),
          })),
          note: context.note,
        };

        const { passages, passages_quoted } = context.coverage;
        return {
          result,
          message: passages
            ? `Read ${passages_quoted} of ${passages} passages across ${context.conversations.length} conversation${context.conversations.length === 1 ? '' : 's'}`
            : 'Nothing recorded in that scope',
        };
      }

      case 'list_conversations': {
        const limit = Number.isFinite(input.limit) ? Math.max(1, Math.min(50, input.limit)) : 10;
        const [conversations, people] = await Promise.all([
          retrieval.recentConversations(limit),
          retrieval.listPeople(),
        ]);
        const byId = new Map(people.map((person) => [person._id, person]));
        const result = conversations.map((conversation) => ({
          id: conversation._id,
          title: conversation.title,
          started_at: conversation.started_at,
          ended_at: conversation.ended_at,
          participants: conversation.participant_ids.map((personId) => {
            const person = byId.get(personId);
            return { person_id: personId, name: person ? describePerson(person) : 'an unnamed voice' };
          }),
        }));
        return {
          result,
          message: result.length ? `${result.length} recent conversations` : 'No conversations recorded',
        };
      }

      case 'list_people': {
        const people = await retrieval.listPeople();
        const result = people.map((person) => ({
          person_id: person._id,
          name: describePerson(person),
          named: !person.is_unnamed && Boolean(person.name?.trim()),
          relationship: person.relationship,
        }));
        return { result, message: result.length ? `${result.length} people` : 'Nobody recorded yet' };
      }

      case 'search_memory': {
        const hits = await memory.searchMemory(input.query, input.person_id);
        return {
          result: hits,
          message: hits.length
            ? `Found ${hits.length} relevant fact${hits.length === 1 ? '' : 's'}`
            : 'No matching facts',
        };
      }

      case 'get_person': {
        const person = await memory.getPerson(input.id);
        return {
          result: person,
          message: person ? person.name : `No person matching "${input.id}"`,
        };
      }

      case 'resolve_fact_state': {
        const fact = await memory.resolveFactState(input.person_id, input.attribute);
        const attribute = String(input.attribute).replace(/_/g, ' ');
        // TODO(contracts): MemoryApi.resolveFactState returns only the current
        // Fact, and Fact.superseded_by points FORWARD (old → new), so the
        // supersession chain is unreachable from here. Until Lane B returns
        // `{current, superseded[]}`, this message can only state the current
        // value — it cannot render "Aug 15 → Aug 20", which is the video's
        // 20–32s beat. Raised with the contracts owner.
        if (fact) return { result: fact, message: `${attribute}: ${fact.claim}` };

        // A miss used to send the model hunting through attribute-name variants
        // ("move date", "move in date", "oakland move date"), burning the whole
        // tool budget and returning no answer at all. Say plainly that guessing
        // will not help.
        return {
          result: {
            found: false,
            attribute: input.attribute,
            hint:
              'No such attribute. Attributes are short single words (move, job, name, ' +
              'preference, project, email). Do not try variations of this name — use the ' +
              'search results you already have.',
          },
          message: `Nothing recorded for ${attribute}`,
        };
      }

      case 'draft_email': {
        const draft = await draftEmail(memory, input.to_person_id, input.subject, input.body);
        // The address comes from memory only — never invented. When there is no
        // email fact on file, say so plainly so the owner knows to save one before
        // the draft can actually go out, instead of discovering a blank recipient
        // in the app.
        const message = draft.to_email
          ? `Draft ready — "${draft.subject}"`
          : `Draft ready — "${draft.subject}" — but I don't have ${draft.to_name ?? 'them'}'s email address saved. Say it or add it in the app, then tap send.`;
        return { result: draft, message };
      }

      case 'create_reminder': {
        const reminder = await memory.createReminder(input.promise_id, input.fire_at);
        return { result: reminder, message: `Reminder set for ${reminder.fire_at}` };
      }

      case 'add_note': {
        const note = await memory.addNote(input.person_id, input.text);
        return { result: note, message: 'Note saved' };
      }

      default:
        return { result: { error: `Unknown tool: ${name}` }, message: `Unknown tool: ${name}`, isError: true };
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { result: { error: detail }, message: `Failed: ${detail}`, isError: true };
  }
}
