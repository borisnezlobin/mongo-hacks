import { REPLY_OPENERS } from './lexicon';
import { FIRST_PERSON_FRAMES, type RawMention } from './rules';
import { tokenize } from './tokens';
import type { NameMention, NamingTurn } from './types';

/** Beyond this the neighbouring turn is a different exchange, not the reply to an address. */
const ADDRESSEE_WINDOW_MS = 20_000;
/**
 * Diarization splits one person's sentence across labels and interleaves it
 * with everybody else's, so "who spoke next" has to mean "who was talking
 * around here" rather than "the very next fragment".
 */
const CROSSTALK_WINDOW_MS = 8_000;

interface AddresseeGuess {
  speaker?: string;
  score: number;
  reasoning: string;
}

interface Neighbour {
  speaker: string;
  gap: number;
}

/**
 * The other voices within earshot on one side of a turn, nearest first, each
 * counted once however many fragments they were split into.
 */
function neighbours(turns: NamingTurn[], from: number, step: 1 | -1, exclude: string): Neighbour[] {
  const origin = turns[from]!;
  const seen = new Map<string, number>();
  for (let i = from + step; i >= 0 && i < turns.length; i += step) {
    const candidate = turns[i]!;
    if (candidate.speaker === exclude) continue;
    if (candidate.text.trim().length === 0) continue;
    const gap = step === 1 ? candidate.start_ms - origin.end_ms : origin.start_ms - candidate.end_ms;
    if (gap > ADDRESSEE_WINDOW_MS) break;
    if (!seen.has(candidate.speaker)) seen.set(candidate.speaker, Math.max(gap, 0));
    if (gap > CROSSTALK_WINDOW_MS) break;
  }
  return [...seen].map(([speaker, gap]) => ({ speaker, gap })).sort((a, b) => a.gap - b.gap);
}

function opensAsReply(text: string): boolean {
  const first = tokenize(text)[0];
  return first !== undefined && REPLY_OPENERS.has(first.key);
}

/**
 * A vocative names somebody else in the room. Whoever answers next is the
 * likeliest addressee, but a turn that opens as a reply is finishing an
 * exchange with whoever just spoke, so the previous voice gets most of the
 * weight instead. When the same voice sits on both sides of the address, the
 * two readings agree and the guess is worth far more than either alone — and
 * when three people are talking at once, none of it is worth much.
 */
function guessAddressee(turns: NamingTurn[], turnIndex: number, preferReply: boolean): AddresseeGuess {
  const speaker = turns[turnIndex]!.speaker;
  const after = neighbours(turns, turnIndex, 1, speaker);
  const before = neighbours(turns, turnIndex, -1, speaker);
  const next = after[0]?.speaker;
  const previous = before[0]?.speaker;
  const reply = !preferReply && opensAsReply(turns[turnIndex]!.text);
  const crowdedAfter = after.length > 1;

  if (next !== undefined && next === previous) {
    return {
      speaker: next,
      score: 1,
      reasoning: 'the same voice speaks immediately before and after the address',
    };
  }
  const weights: AddresseeGuess[] = [];
  if (next !== undefined) {
    const answering = preferReply ? 0.85 : 0.75;
    weights.push({
      speaker: next,
      score: (reply ? 0.6 : answering) * (crowdedAfter ? 0.8 : 1),
      reasoning: crowdedAfter
        ? 'the next voice to speak answers the address, over other voices talking at the same time'
        : 'the next voice to speak answers the address',
    });
  }
  if (previous !== undefined) {
    weights.push({
      speaker: previous,
      score: reply ? 0.7 : 0.5,
      reasoning: reply
        ? 'the turn replies to the voice that just spoke'
        : 'the voice that spoke just before the address',
    });
  }
  weights.sort((a, b) => b.score - a.score);
  const best = weights[0];
  if (best === undefined) {
    return { speaker: undefined, score: 0, reasoning: 'nobody else spoke near the address' };
  }
  const runnerUp = weights[1];
  if (runnerUp !== undefined && best.score - runnerUp.score < 0.15) {
    return { ...best, score: best.score * 0.6, reasoning: `${best.reasoning}, but another voice is as likely` };
  }
  return best;
}

export function attributeMentions(turns: NamingTurn[], raw: RawMention[]): NameMention[] {
  return raw.map((mention) => {
    const turn = turns[mention.turnIndex]!;
    const base = {
      name: mention.name,
      kind: mention.kind,
      frame: mention.frame,
      turn_id: turn.id,
      speaker: turn.speaker,
      evidence: mention.evidence,
      source: 'rules' as const,
    };

    if (FIRST_PERSON_FRAMES.has(mention.frame)) {
      return {
        ...base,
        target: turn.speaker,
        strength: mention.strength,
        reasoning: `${mention.detail}, so the name belongs to the speaker`,
      };
    }
    if (mention.frame === 'third_person') {
      return {
        ...base,
        target: undefined,
        strength: mention.strength,
        reasoning: `${mention.detail}; nobody present is being named`,
      };
    }

    // A name checked as a question — "you Boris?" — or a person being
    // introduced is about whoever speaks next, so the voice that answers
    // counts for more than usual.
    const answered = mention.frame === 'name_question' || mention.frame === 'presentation';
    const addressee = guessAddressee(turns, mention.turnIndex, answered);
    return {
      ...base,
      target: addressee.speaker,
      strength: mention.strength * addressee.score,
      reasoning: `${mention.detail}; ${addressee.reasoning}`,
    };
  });
}
