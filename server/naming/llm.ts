import { STOP_WORDS } from './lexicon';
import { titleCase } from './tokens';
import type { EvidenceFrame } from './rules';
import type { NameEvidenceKind, NameMention, NamingTurn } from './types';

/**
 * Shaped to match `extractStructured` in server/memory/llm.ts so the wiring is
 * a one-liner, but injected rather than imported: the detector must run with
 * no network and no key.
 */
export interface NameLlmRequest {
  system: string;
  user: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
}

export type NameLlm = (request: NameLlmRequest) => Promise<unknown>;

interface LlmMention {
  name?: unknown;
  kind?: unknown;
  turn_id?: unknown;
  target_speaker?: unknown;
  evidence?: unknown;
}

const WINDOW_TURNS = 40;
const WINDOW_OVERLAP = 6;

/** An LLM guess never outranks a corroborated rule match; it can only add to one. */
const LLM_STRENGTH: Record<NameEvidenceKind, number> = {
  self_introduction: 0.65,
  vocative: 0.5,
  third_person_reference: 0.15,
};

const SYSTEM = [
  'You find people\'s names in a diarized conversation transcript.',
  'Each line is "[turn_id] SPEAKER: text". Speaker labels are voices, not names.',
  'Report only names of humans. Never report apps, places, buildings, brands, or courses.',
  'kind is one of: self_introduction (the speaker states their own name),',
  'vocative (the speaker addresses somebody else by name),',
  'third_person_reference (somebody not in the room is named).',
  'target_speaker is the label of the voice the name belongs to: the speaker for a',
  'self_introduction, the person being addressed for a vocative, omitted otherwise.',
  'evidence must be copied verbatim from the transcript line.',
  'Report nothing when unsure. An empty list is the correct answer for most windows.',
].join(' ');

const SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['mentions'],
  properties: {
    mentions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'kind', 'turn_id', 'evidence'],
        properties: {
          name: { type: 'string' },
          kind: { type: 'string', enum: ['self_introduction', 'vocative', 'third_person_reference'] },
          turn_id: { type: 'string' },
          target_speaker: { type: 'string' },
          evidence: { type: 'string' },
        },
      },
    },
  },
};

function windows(turns: NamingTurn[]): NamingTurn[][] {
  if (turns.length <= WINDOW_TURNS) return turns.length > 0 ? [turns] : [];
  const chunks: NamingTurn[][] = [];
  for (let start = 0; start < turns.length; start += WINDOW_TURNS - WINDOW_OVERLAP) {
    chunks.push(turns.slice(start, start + WINDOW_TURNS));
    if (start + WINDOW_TURNS >= turns.length) break;
  }
  return chunks;
}

function render(turns: NamingTurn[]): string {
  return turns.map((turn) => `[${turn.id}] ${turn.speaker}: ${turn.text.trim()}`).join('\n');
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * A model that invents a quote has invented the name too, so every mention is
 * checked back against the transcript before it is allowed to carry weight.
 */
function validate(raw: LlmMention, turns: NamingTurn[]): NameMention | undefined {
  if (typeof raw.name !== 'string' || typeof raw.kind !== 'string' || typeof raw.turn_id !== 'string') return undefined;
  if (typeof raw.evidence !== 'string') return undefined;
  if (!(raw.kind in LLM_STRENGTH)) return undefined;
  const kind = raw.kind as NameEvidenceKind;

  const turn = turns.find((candidate) => candidate.id === raw.turn_id);
  if (turn === undefined) return undefined;
  if (!normalize(turn.text).includes(normalize(raw.evidence))) return undefined;

  const name = raw.name.trim().split(/\s+/)[0] ?? '';
  if (!/^\p{L}[\p{L}\p{M}'’-]{1,14}$/u.test(name)) return undefined;
  if (STOP_WORDS.has(name.toLowerCase())) return undefined;
  if (!normalize(raw.evidence).includes(name.toLowerCase())) return undefined;

  let target: string | undefined;
  if (kind === 'self_introduction') target = turn.speaker;
  else if (kind === 'vocative') {
    if (typeof raw.target_speaker !== 'string') return undefined;
    if (raw.target_speaker === turn.speaker) return undefined;
    if (!turns.some((candidate) => candidate.speaker === raw.target_speaker)) return undefined;
    target = raw.target_speaker;
  }

  const frame: EvidenceFrame =
    kind === 'self_introduction' ? 'self_statement' : kind === 'vocative' ? 'address' : 'third_person';

  return {
    name: titleCase(name),
    kind,
    frame,
    turn_id: turn.id,
    speaker: turn.speaker,
    evidence: raw.evidence.trim(),
    strength: LLM_STRENGTH[kind],
    target,
    reasoning: 'the language model read the surrounding transcript',
    source: 'llm',
  };
}

/** Returns an empty list rather than throwing: the rule pass is always the floor. */
export async function llmMentions(turns: NamingTurn[], llm: NameLlm): Promise<NameMention[]> {
  const mentions: NameMention[] = [];
  const seen = new Set<string>();

  for (const window of windows(turns)) {
    let reply: unknown;
    try {
      reply = await llm({ system: SYSTEM, user: render(window), schema: SCHEMA, maxTokens: 1_500 });
    } catch {
      continue;
    }
    const raw = (reply as { mentions?: unknown } | null)?.mentions;
    if (!Array.isArray(raw)) continue;
    for (const item of raw) {
      const mention = validate(item as LlmMention, window);
      if (mention === undefined) continue;
      const key = `${mention.turn_id}::${mention.name}::${mention.target ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      mentions.push(mention);
    }
  }
  return mentions;
}
