/**
 * Model-provider abstraction for the agent loop.
 *
 * Two providers, selected by AMELIA_PROVIDER:
 *   anthropic  — Claude Opus 5 via the Messages API (tool_use / tool_result blocks)
 *   fireworks  — open-weights models via the OpenAI-compatible chat-completions API
 *
 * These are NOT the same model family and not the same wire format, so the loop
 * talks to this normalized surface and each provider translates.
 */

import type { Id } from '../../shared/contracts';

/** Provider-neutral tool description. Converted per provider. */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, any>;
}

export type Turn =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text?: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string; isError?: boolean };

export type StopReason = 'end' | 'tools' | 'max_tokens' | 'refusal' | 'pause';

export interface Completion {
  text: string;
  toolCalls: ToolCall[];
  stop: StopReason;
}

export interface CompletionRequest {
  system: string;
  turns: Turn[];
  tools: ToolSpec[];
  /** false ⇒ force a final answer (the tool-call cap has been reached). */
  allowTools: boolean;
  signal?: AbortSignal;
}

export interface LlmProvider {
  readonly id: Id;
  readonly model: string;
  complete(request: CompletionRequest): Promise<Completion>;
}

/** Parse tool arguments defensively — a bad payload must not kill the turn. */
export function parseArgs(raw: unknown): Record<string, any> {
  if (raw && typeof raw === 'object') return raw as Record<string, any>;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}
