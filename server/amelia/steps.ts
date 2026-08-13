import type { AmeliaStepEvent, Id } from '../../shared/contracts';

/**
 * Lane 0's AmeliaStepEvent is `{request_id, step, message}` — a fixed enum plus
 * free text. The enum is what Lane C switches on for iconography; `message` is
 * the Mongo-flavoured copy the demo actually reads.
 */
export type StepKind = AmeliaStepEvent['step'];

export type Emit = (event: AmeliaStepEvent) => void;

export interface Stepper {
  /** The whole trace for this request, in order. */
  steps: AmeliaStepEvent[];
  step(step: StepKind, message: string): AmeliaStepEvent;
}

/**
 * Binds one request_id so callers can't accidentally interleave two summons.
 *
 * Create exactly ONE per request and share it — a second stepper would keep its
 * own `steps` array, so the trace returned to the caller would silently disagree
 * with what went out over the bus.
 */
export function createStepper(requestId: Id, emit: Emit): Stepper {
  const steps: AmeliaStepEvent[] = [];
  return {
    steps,
    step(step: StepKind, message: string): AmeliaStepEvent {
      const event: AmeliaStepEvent = { type: 'amelia_step', request_id: requestId, step, message };
      steps.push(event);
      emit(event);
      return event;
    },
  };
}

/** Which enum bucket each tool reports under. */
export const TOOL_STEP: Record<string, StepKind> = {
  search_memory: 'search',
  get_person: 'search',
  resolve_fact_state: 'search',
  draft_email: 'act',
  create_reminder: 'act',
  add_note: 'act',
};
