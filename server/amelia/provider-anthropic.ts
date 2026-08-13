/**
 * Anthropic provider — Claude Opus 5 via the Messages API.
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
import type {
  Completion,
  CompletionRequest,
  LlmProvider,
  StopReason,
  ToolCall,
} from './provider';

const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-opus-5';
const MAX_TOKENS = Number(process.env.AMELIA_MAX_TOKENS ?? 8000);
/** low | medium | high — demo latency lives here. Opus 5 is strong at medium. */
const EFFORT = (process.env.AMELIA_EFFORT ?? 'medium') as 'low' | 'medium' | 'high';

function toStop(reason: string | null): StopReason {
  switch (reason) {
    case 'tool_use':
      return 'tools';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    case 'pause_turn':
      return 'pause';
    default:
      return 'end';
  }
}

export function createAnthropicProvider(): LlmProvider {
  let client: Anthropic | null = null;
  /** Lazy so importing this module doesn't throw when the key isn't set. */
  const getClient = () => (client ??= new Anthropic());

  return {
    id: 'anthropic',
    model: MODEL,

    async complete({ system, turns, tools, allowTools, signal }: CompletionRequest): Promise<Completion> {
      const messages: Anthropic.MessageParam[] = [];
      for (const turn of turns) {
        if (turn.role === 'user') {
          messages.push({ role: 'user', content: turn.text });
        } else if (turn.role === 'assistant') {
          const blocks: Anthropic.ContentBlockParam[] = [];
          if (turn.text) blocks.push({ type: 'text', text: turn.text });
          for (const call of turn.toolCalls ?? []) {
            blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
          }
          messages.push({ role: 'assistant', content: blocks });
        } else {
          // Consecutive tool results must land in ONE user message or Claude
          // stops batching parallel tool calls — merge into the previous turn.
          const block: Anthropic.ToolResultBlockParam = {
            type: 'tool_result',
            tool_use_id: turn.toolCallId,
            content: turn.content,
            is_error: turn.isError ?? false,
          };
          const last = messages[messages.length - 1];
          if (last?.role === 'user' && Array.isArray(last.content)) {
            (last.content as Anthropic.ContentBlockParam[]).push(block);
          } else {
            messages.push({ role: 'user', content: [block] });
          }
        }
      }

      const response = await getClient().messages.create(
        {
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system,
          thinking: { type: 'adaptive' },
          output_config: { effort: EFFORT },
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.parameters as Anthropic.Tool['input_schema'],
          })),
          // Keep `tools` in the request even at the cap — history already holds
          // tool_use blocks, and dropping the definitions invalidates them.
          // `none` is what actually forces the final answer.
          tool_choice: allowTools ? { type: 'auto' } : { type: 'none' },
          messages,
        },
        { signal },
      );

      const toolCalls: ToolCall[] = response.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
        .map((b) => ({ id: b.id, name: b.name, input: b.input as Record<string, any> }));

      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();

      return { text, toolCalls, stop: toStop(response.stop_reason) };
    },
  };
}
