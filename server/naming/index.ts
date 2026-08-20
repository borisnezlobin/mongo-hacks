import type { NameSuggestionEvent } from '../../shared/contracts';
import { llmMentions, type NameLlm } from './llm';
import { ruleMentions, scoreMentions, suggestNames } from './suggest';
import type { NamingContext, NamingResult, NamingTurn } from './types';

export type {
  KnownParticipant,
  NameEvidenceKind,
  NameMention,
  NamingContext,
  NamingResult,
  NamingTurn,
  SuppressedSuggestion,
  SuppressionReason,
} from './types';
export type { EvidenceFrame } from './rules';
export type { NameLlm, NameLlmRequest } from './llm';
export { suggestNames } from './suggest';

/**
 * Rules first, then the model on top of the same transcript. The two agree
 * often enough that agreement is itself the corroboration signal; when the
 * model is unavailable the result is exactly the rule-only result.
 */
export async function suggestNamesWithLlm(context: NamingContext, llm?: NameLlm): Promise<NamingResult> {
  if (llm === undefined) return suggestNames(context);
  const mentions = [...ruleMentions(context), ...(await llmMentions(context.turns, llm))];
  return scoreMentions(mentions, context);
}

/** Confidence must climb by this much before the same suggestion is emitted again. */
const RESTATEMENT_STEP = 0.05;

/**
 * Accumulates evidence across a live conversation. Turns may be re-ingested
 * with the same id when transcription revises them, and a name that keeps
 * coming up strengthens its existing suggestion instead of producing a
 * second one.
 */
export class NameSuggester {
  private readonly turns = new Map<string, NamingTurn>();
  private readonly emitted = new Map<string, number>();
  private context: Omit<NamingContext, 'turns'>;

  constructor(context: Omit<NamingContext, 'turns'>) {
    this.context = context;
  }

  updateContext(patch: Partial<Omit<NamingContext, 'turns'>>): void {
    this.context = { ...this.context, ...patch };
  }

  ingest(turn: NamingTurn | NamingTurn[]): void {
    for (const one of Array.isArray(turn) ? turn : [turn]) this.turns.set(one.id, one);
  }

  private ordered(): NamingTurn[] {
    return [...this.turns.values()].sort((a, b) => a.start_ms - b.start_ms || a.id.localeCompare(b.id));
  }

  current(): NamingResult {
    return suggestNames({ ...this.context, turns: this.ordered() });
  }

  async currentWithLlm(llm?: NameLlm): Promise<NamingResult> {
    return suggestNamesWithLlm({ ...this.context, turns: this.ordered() }, llm);
  }

  /** Suggestions worth putting in front of the user right now, deduplicated across calls. */
  drain(result: NamingResult = this.current()): NameSuggestionEvent[] {
    const fresh: NameSuggestionEvent[] = [];
    for (const suggestion of result.suggestions) {
      const key = `${suggestion.session_speaker ?? suggestion.person_id ?? ''}::${suggestion.name}`;
      const previous = this.emitted.get(key);
      if (previous !== undefined && suggestion.confidence < previous + RESTATEMENT_STEP) continue;
      this.emitted.set(key, suggestion.confidence);
      fresh.push(suggestion);
    }
    return fresh;
  }
}
