/**
 * Fireworks provider — OpenAI-compatible chat completions.
 *
 * Unlike Opus 5, these models DO accept `temperature`, so the loop is pinned at
 * 0 for reproducibility. There is no thinking/effort surface here; depth comes
 * from the model choice.
 *
 * Model is env-overridable (FIREWORKS_MODEL) so swapping is a one-line change:
 * these are open-weights models and their tool-calling reliability varies more
 * than Claude's, so expect to try a couple.
 */

import {
  parseArgs,
  type Completion,
  type CompletionRequest,
  type LlmProvider,
  type StopReason,
  type ToolCall,
} from './provider';

const ENDPOINT = 'https://api.fireworks.ai/inference/v1/chat/completions';
const DEFAULT_MODEL = process.env.FIREWORKS_MODEL ?? 'accounts/fireworks/models/kimi-k3';
const MAX_TOKENS = Number(process.env.AMELIA_MAX_TOKENS ?? 4096);

interface OpenAiToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

function toStop(reason: string | undefined, hasToolCalls: boolean): StopReason {
  if (hasToolCalls) return 'tools';
  switch (reason) {
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return 'end';
  }
}

export function createFireworksProvider(): LlmProvider {
  const apiKey = process.env.FIREWORKS_API_KEY;
  const model = DEFAULT_MODEL;

  return {
    id: 'fireworks',
    model,

    async complete({ system, turns, tools, allowTools, signal }: CompletionRequest): Promise<Completion> {
      if (!apiKey) throw new Error('FIREWORKS_API_KEY is not set');

      const messages: Record<string, unknown>[] = [{ role: 'system', content: system }];
      for (const turn of turns) {
        if (turn.role === 'user') {
          messages.push({ role: 'user', content: turn.text });
        } else if (turn.role === 'assistant') {
          messages.push({
            role: 'assistant',
            content: turn.text ?? '',
            ...(turn.toolCalls?.length
              ? {
                  tool_calls: turn.toolCalls.map((call) => ({
                    id: call.id,
                    type: 'function',
                    function: { name: call.name, arguments: JSON.stringify(call.input) },
                  })),
                }
              : {}),
          });
        } else {
          // OpenAI shape has no is_error flag — inline it so the model sees it.
          messages.push({
            role: 'tool',
            tool_call_id: turn.toolCallId,
            content: turn.isError ? `ERROR: ${turn.content}` : turn.content,
          });
        }
      }

      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        signal,
        body: JSON.stringify({
          model,
          messages,
          max_tokens: MAX_TOKENS,
          temperature: 0,
          tools: tools.map((tool) => ({
            type: 'function',
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            },
          })),
          tool_choice: allowTools ? 'auto' : 'none',
        }),
      });

      if (!response.ok) {
        throw new Error(`Fireworks ${response.status}: ${(await response.text()).slice(0, 300)}`);
      }

      const body = (await response.json()) as {
        choices?: { message?: { content?: string; tool_calls?: OpenAiToolCall[] }; finish_reason?: string }[];
      };
      const choice = body.choices?.[0];
      const rawCalls = choice?.message?.tool_calls ?? [];

      const toolCalls: ToolCall[] = rawCalls
        .filter((call) => call.function?.name)
        .map((call, index) => ({
          // Some servers omit the id; the loop needs a stable one to pair results.
          id: call.id ?? `call_${index}`,
          name: call.function!.name!,
          input: parseArgs(call.function?.arguments),
        }));

      return {
        text: (choice?.message?.content ?? '').trim(),
        toolCalls,
        stop: toStop(choice?.finish_reason, toolCalls.length > 0),
      };
    },
  };
}
