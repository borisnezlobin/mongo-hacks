/**
 * Amelia's tool surface.
 *
 * Seven tools bind to Lane B's frozen MemoryApi; `draft_email` is Lane D's own.
 * Lane D never writes Lane B's collections directly.
 *
 * `set_name` and `set_birthday` are the only two that change anything a person
 * is, and they arrive over a voice channel. What stands between a stranger and
 * a write is the wake gate in wake.ts, which admits the owner at
 * OWNER_AUTH_THRESHOLD — deliberately the LOOSER of the two thresholds, and
 * currently the same 0.6 as ordinary attribution. That was defensible when
 * every tool only read. It is worth revisiting now that two of them do not.
 */

import { TONIGHT_DEFAULT_HOUR, type MemoryApi } from '../../shared/contracts';
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
      'move, job, name, preference, project, email, birthday. Use one of those exactly. ' +
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
    name: 'set_name',
    description:
      'Give a person a name, or correct the name they already have. Call this when the owner ' +
      'says who somebody is — "that one is Tarun", "her name is Maya, not Maia". ' +
      'Resolve the person first with get_person or search_memory and pass their id. Never ' +
      'guess which person is meant: naming the wrong one re-files everything that person ever ' +
      'said under somebody else, and there is no way to undo it from here.',
    parameters: {
      type: 'object',
      properties: {
        person_id: { type: 'string', description: 'The person to name. An id, not a name.' },
        name: { type: 'string', description: 'What to call them, spelled the way it was said.' },
        relationship: {
          type: 'string',
          description: 'Optional, only when stated — "my roommate", "lab partner".',
        },
      },
      required: ['person_id', 'name'],
    },
  },
  {
    name: 'set_birthday',
    description:
      "Record or correct someone's birthday when it is said out loud — \"I'm Tarun and my " +
      'birthday is July fifteenth". Resolve the person first and pass their id. ' +
      'Pass the date as it was spoken; do not add a year nobody said, and do not convert it ' +
      'to a format of your own. The previous value is kept and superseded automatically, so ' +
      'correcting a birthday is safe and does not lose what it was before.',
    parameters: {
      type: 'object',
      properties: {
        person_id: { type: 'string', description: 'The person whose birthday this is.' },
        birthday: { type: 'string', description: 'The date as spoken, e.g. "July 15" or "15 July 1986".' },
      },
      required: ['person_id', 'birthday'],
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
              'No such attribute. Attributes are short single words (move, job, name, birthday, ' +
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

      case 'set_name': {
        const person = await memory.namePerson(input.person_id, input.name, input.relationship);
        // A rename of somebody who is not there is a silent no-op otherwise,
        // and the model would go on to speak as though it had worked.
        if (!person) {
          return {
            result: { error: 'no such person', person_id: input.person_id },
            message: `No person matching "${input.person_id}"`,
            isError: true,
          };
        }
        return { result: person, message: `Named ${person.name}` };
      }

      case 'set_birthday': {
        // Facts carry a person_id but nothing enforces that it points at a live
        // person, so an unresolved id would write a fact nobody can ever reach.
        const subject = await memory.getPerson(input.person_id);
        if (!subject) {
          return {
            result: { error: 'no such person', person_id: input.person_id },
            message: `No person matching "${input.person_id}"`,
            isError: true,
          };
        }
        const recorded = await memory.setFact(subject._id, 'birthday', input.birthday);
        return { result: recorded, message: `${subject.name}'s birthday: ${recorded.claim}` };
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
