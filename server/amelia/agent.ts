/**
 * Amelia's agent loop.
 *
 * Provider-neutral: it talks to the normalized surface in provider.ts, so the
 * same loop runs on Claude Opus 5 (Messages API) or a Fireworks open-weights
 * model (OpenAI-compatible). Per-provider request params live in the provider
 * modules, not here.
 *
 * Hand-written rather than an SDK tool runner because we emit one amelia_step
 * per turn AND convert the tool-call cap into a forced final answer ("partial
 * answer at cap beats stalling").
 */

import {
  AMELIA_MAX_TOOL_CALLS,
  type AmeliaStepEvent,
  type Id,
  type MemoryApi,
} from '../../shared/contracts';
import { getProvider } from './provider-factory';
import type { Turn } from './provider';
import { TOOL_STEP, type Stepper } from './steps';
import { TOOLS, runTool } from './tools';

/**
 * Built per request, not once at import.
 *
 * "Today" used to be baked in when the module first loaded, so a server left
 * running overnight told the model the wrong date indefinitely — and every
 * "tomorrow" or "tonight" it resolved into a promise was then filed against the
 * wrong day, which is exactly the kind of error nobody notices until a reminder
 * fires late.
 */
const systemPrompt = (today = new Date()) => `You are Amelia. You are the owner's memory of the people in their life.

You are answering out loud, in a room, while the conversation continues around you.
Keep spoken replies to one or two sentences. No preamble, no restating the question,
no lists. Say the answer.

Facts change. Before you act on anything dated — a move-in date, an address, a plan —
call resolve_fact_state and use the current value, not the first search hit you saw.
When a request branches on such a fact ("if she's already moved… if she hasn't…"),
resolve the fact first, decide the branch yourself, and act on that one branch only.
Never ask the owner which branch applies.

Questions about a stretch of conversation — what was discussed, who was in the room,
what somebody spent an evening talking about — are answered by gathering context for a
scope, not by searching for words the question happens to contain. A broad question
usually contains no words worth searching for.

Say who said what, using the speaker label on the line you are drawing from. A voice
that has not been named stays "Speaker 2"; never put a name to one, and never move a
remark from one speaker to another.

What you are given is a sample of the conversation, not all of it. Answer from it and
say when something is not there. Never fill a gap from general knowledge — being wrong
about a real person costs more than admitting you do not know.

Today is ${today.toISOString().slice(0, 10)}.

Email is always a draft for the owner to review. Never claim you sent one.
Refer to people by name, not by id, when you speak.`;

export interface AmeliaResult {
  request_id: Id;
  /** The spoken reply. Empty when refused, truncated, or aborted. */
  text: string;
  steps: AmeliaStepEvent[];
  toolCallsUsed: number;
  cappedOut: boolean;
  refused: boolean;
  /** Model hit its output cap mid-turn — the reply is unusable, not just short. */
  truncated: boolean;
  /** A newer summon superseded this run. */
  aborted: boolean;
  /** Which backend answered, for the trace. */
  provider: string;
}

export interface RunOptions {
  requestId: Id;
  command: string;
  memory: MemoryApi;
  /** Shared with the caller so AmeliaResult.steps holds the WHOLE trace. */
  stepper: Stepper;
  signal?: AbortSignal;
}

export async function runAmelia({
  requestId,
  command,
  memory,
  stepper,
  signal,
}: RunOptions): Promise<AmeliaResult> {
  const provider = getProvider();
  const turns: Turn[] = [{ role: 'user', text: command }];
  const { steps, step } = stepper;
  let toolCallsUsed = 0;
  let cappedOut = false;

  const outcome = (over: Partial<AmeliaResult>): AmeliaResult => ({
    request_id: requestId,
    text: '',
    steps,
    toolCallsUsed,
    cappedOut,
    refused: false,
    truncated: false,
    aborted: false,
    provider: `${provider.id}:${provider.model}`,
    ...over,
  });

  // Each turn spends at least one tool call, so the cap plus one forced-answer
  // turn bounds this. The +2 is a belt-and-braces stop.
  for (let turn = 0; turn < AMELIA_MAX_TOOL_CALLS + 2; turn++) {
    // A superseded run must stop touching the bus and stop running tools with
    // side effects — abort is not just about cancelling the HTTP request.
    if (signal?.aborted) return outcome({ aborted: true });

    const completion = await provider.complete({
      system: systemPrompt(),
      turns,
      tools: TOOLS,
      allowTools: toolCallsUsed < AMELIA_MAX_TOOL_CALLS,
      signal,
    });

    if (signal?.aborted) return outcome({ aborted: true });

    if (completion.stop === 'refusal') {
      step('denied', 'Amelia would not answer that');
      return outcome({ refused: true });
    }

    // The output cap covers reasoning + text, so a truncated turn can carry no
    // usable text at all. Treating that as a normal reply makes Amelia go
    // silent while the UI reads "Answering".
    if (completion.stop === 'max_tokens' && !completion.toolCalls.length) {
      step('error', 'Ran out of room mid-thought — try again at lower effort');
      return outcome({ truncated: true });
    }

    if (completion.stop === 'pause') {
      turns.push({ role: 'assistant', text: completion.text, toolCalls: completion.toolCalls });
      continue;
    }

    if (!completion.toolCalls.length) {
      step('reply', cappedOut ? 'Partial answer — tool budget spent' : 'Answering');
      return outcome({ text: completion.text });
    }

    turns.push({ role: 'assistant', text: completion.text, toolCalls: completion.toolCalls });

    // Every tool call gets exactly one result. Both providers require the
    // pairing; the Anthropic one additionally merges them into a single user
    // message so parallel tool use keeps working.
    for (const call of completion.toolCalls) {
      // Re-check per tool: the abandoned run must not fire create_reminder,
      // add_note, or draft_email on its way out.
      if (signal?.aborted) return outcome({ aborted: true });

      toolCallsUsed++;
      const toolOutcome = await runTool(memory, call.name, call.input);
      if (signal?.aborted) return outcome({ aborted: true });

      step(TOOL_STEP[call.name] ?? 'reason', toolOutcome.message);
      turns.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: JSON.stringify(toolOutcome.result ?? null),
        isError: toolOutcome.isError,
      });
    }

    if (toolCallsUsed >= AMELIA_MAX_TOOL_CALLS) cappedOut = true;
  }

  step('error', 'Stopped after the maximum number of steps');
  return outcome({ cappedOut: true });
}
