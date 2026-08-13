/**
 * Amelia's tool surface.
 *
 * Five tools bind to Lane B's frozen MemoryApi; `draft_email` is Lane D's own.
 * Lane D never writes Lane B's collections directly.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { TONIGHT_DEFAULT_HOUR, type MemoryApi } from '../../shared/contracts';
import { draftEmail } from './email';

/**
 * Descriptions are prescriptive about WHEN to call, not just what the tool
 * does — Opus-tier models reach for tools conservatively otherwise.
 */
export const TOOLS: Anthropic.Tool[] = [
  {
    name: 'search_memory',
    description:
      "Search everything Amelia has recorded about the people in the owner's life. " +
      'Call this first whenever the request depends on something a person said — a trip, ' +
      'a job, a preference, a plan. Pass person_id to scope the search when you already ' +
      'know who is meant.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you are looking for, in plain language.' },
        person_id: { type: 'string', description: 'Optional. Restrict to one person.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_person',
    description:
      'Look up one person by id. Call this to turn a name in the request into a person_id ' +
      'before scoping other calls, or to read their details.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'resolve_fact_state',
    description:
      'Get the CURRENT value of one attribute for one person. Call this whenever a fact ' +
      'could have changed over time — dates, addresses, job titles, plans — and always ' +
      'before acting on such a fact. Answering from a search hit alone risks using ' +
      'information the person has since revised.',
    input_schema: {
      type: 'object',
      properties: {
        person_id: { type: 'string' },
        attribute: {
          type: 'string',
          description: 'Short attribute key, e.g. "move_in_date", "recent_trip", "email".',
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
    input_schema: {
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
    input_schema: {
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
    input_schema: {
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

export async function runTool(
  memory: MemoryApi,
  name: string,
  input: Record<string, any>,
): Promise<ToolOutcome> {
  try {
    switch (name) {
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
        return {
          result: fact,
          message: fact ? `${attribute}: ${fact.claim}` : `Nothing recorded for ${attribute}`,
        };
      }

      case 'draft_email': {
        const draft = await draftEmail(memory, input.to_person_id, input.subject, input.body);
        return { result: draft, message: `Draft ready — "${draft.subject}"` };
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
