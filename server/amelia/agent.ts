/**
 * Amelia's agent loop.
 *
 * A hand-written loop rather than the SDK tool runner: we emit one amelia_step
 * per turn AND convert the tool-call cap into a forced final answer ("partial
 * answer at cap beats stalling"), which is the one shape the runner's per-turn
 * hooks don't give us for free.
 *
 * NOTE ON MODEL PARAMS — do not "restore" these:
 *   • No `temperature`. Sampling params are REMOVED on Opus 5 and return a 400.
 *     Determinism comes from a tight system prompt plus a low effort level.
 *   • Thinking stays ON. With thinking disabled, Opus 5 occasionally writes a
 *     tool call into visible text instead of emitting a tool_use block — the
 *     call silently never runs. On a stage demo that is a dead Amelia.
 *   • `max_tokens` caps thinking + text together, so it needs real headroom.
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  AMELIA_MAX_TOOL_CALLS,
  type AmeliaStepEvent,
  type Id,
  type MemoryApi,
} from '../../shared/contracts';
import { TOOL_STEP, createStepper, type Emit } from './steps';
import { TOOLS, runTool } from './tools';

const MODEL = 'claude-opus-5';
const MAX_TOKENS = 8_000;
/** low | medium | high — demo latency lives here. Opus 5 is strong at medium. */
const EFFORT = (process.env.AMELIA_EFFORT ?? 'medium') as 'low' | 'medium' | 'high';

const SYSTEM = `You are Amelia. You are the owner's memory of the people in their life.

You are answering out loud, in a room, while the conversation continues around you.
Keep spoken replies to one or two sentences. No preamble, no restating the question,
no lists. Say the answer.

Facts change. Before you act on anything dated — a move-in date, an address, a plan —
call resolve_fact_state and use the current value, not the first search hit you saw.
When a request branches on such a fact ("if he's already moved in… if he hasn't…"),
resolve the fact first, decide the branch yourself, and act on that one branch only.
Never ask the owner which branch applies.

Today is ${new Date().toISOString().slice(0, 10)}.

Email is always a draft for the owner to review. Never claim you sent one.
Refer to people by name, not by id, when you speak.`;

export interface AmeliaResult {
  request_id: Id;
  /** The spoken reply. Empty only if the model refused or the loop ran out. */
  text: string;
  steps: AmeliaStepEvent[];
  toolCallsUsed: number;
  cappedOut: boolean;
  refused: boolean;
}

export interface RunOptions {
  requestId: Id;
  command: string;
  memory: MemoryApi;
  emit: Emit;
  signal?: AbortSignal;
}

let client: Anthropic | null = null;
/** Lazy so importing this module doesn't throw when the key isn't set yet. */
function getClient(): Anthropic {
  client ??= new Anthropic();
  return client;
}

export async function runAmelia({
  requestId,
  command,
  memory,
  emit,
  signal,
}: RunOptions): Promise<AmeliaResult> {
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: command }];
  const { steps, step } = createStepper(requestId, emit);
  let toolCallsUsed = 0;
  let cappedOut = false;

  // Each turn spends at least one tool call, so the cap plus one forced-answer
  // turn bounds this. The +2 is a belt-and-braces stop.
  for (let turn = 0; turn < AMELIA_MAX_TOOL_CALLS + 2; turn++) {
    const atCap = toolCallsUsed >= AMELIA_MAX_TOOL_CALLS;

    const response = await getClient().messages.create(
      {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM,
        thinking: { type: 'adaptive' },
        output_config: { effort: EFFORT },
        tools: TOOLS,
        // Keep `tools` in the request even at the cap — history already holds
        // tool_use blocks, and dropping the definitions invalidates them.
        // `none` is what actually forces the final answer.
        tool_choice: atCap ? { type: 'none' } : { type: 'auto' },
        messages,
      },
      { signal },
    );

    if (response.stop_reason === 'refusal') {
      step('denied', 'Amelia would not answer that');
      return { request_id: requestId, text: '', steps, toolCallsUsed, cappedOut, refused: true };
    }

    // No server-side tools in play, but an unhandled pause would otherwise look
    // like a silent truncation.
    if (response.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: response.content });
      continue;
    }

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );

    if (response.stop_reason !== 'tool_use' || toolUses.length === 0) {
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
      step('reply', cappedOut ? 'Partial answer — tool budget spent' : 'Answering');
      return { request_id: requestId, text, steps, toolCallsUsed, cappedOut, refused: false };
    }

    messages.push({ role: 'assistant', content: response.content });

    // Claude may request several tools per turn — run them together and return
    // every result in ONE user message, or it stops batching.
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      toolCallsUsed++;
      const outcome = await runTool(memory, use.name, use.input as Record<string, any>);
      step(TOOL_STEP[use.name] ?? 'reason', outcome.message);
      results.push({
        type: 'tool_result',
        tool_use_id: use.id,
        content: JSON.stringify(outcome.result ?? null),
        is_error: outcome.isError ?? false,
      });
    }
    messages.push({ role: 'user', content: results });

    if (toolCallsUsed >= AMELIA_MAX_TOOL_CALLS) cappedOut = true;
  }

  step('error', 'Stopped after the maximum number of steps');
  return { request_id: requestId, text: '', steps, toolCallsUsed, cappedOut: true, refused: false };
}
