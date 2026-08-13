import { EXTRACTION_MODEL } from '../../shared/contracts';
import { fireworksBaseUrl, fireworksKey } from './fireworks';

export interface ExtractionRequest {
  system: string;
  user: string;
  /** JSON Schema the reply is constrained to; objects need `additionalProperties: false`. */
  schema: Record<string, unknown>;
  maxTokens?: number;
  /**
   * gpt-oss thinks before it answers, and the thinking dominates wall clock:
   * the same call measured 735 ms at `low` and 2,354 ms at `high`. Extraction
   * leaves this unset and keeps the model's default; retrieval, which is on the
   * interactive path and asks much smaller questions, sets `low`.
   */
  reasoningEffort?: 'low' | 'medium' | 'high';
}

interface ChatCompletion {
  choices: Array<{ message: { content: string | null }; finish_reason: string }>;
}

/**
 * Structured output rather than a tool-use loop: the passes want one
 * schema-valid object, not an agent. Fireworks constrains decoding to the
 * schema, so the reply cannot drift from the shape and there is no
 * parse-retry path to maintain.
 */
export async function extractStructured<T>(request: ExtractionRequest): Promise<T> {
  const response = await fetch(`${fireworksBaseUrl()}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${fireworksKey()}` },
    body: JSON.stringify({
      model: EXTRACTION_MODEL,
      max_tokens: request.maxTokens ?? 4_000,
      temperature: 0,
      response_format: { type: 'json_object', schema: request.schema },
      ...(request.reasoningEffort ? { reasoning_effort: request.reasoningEffort } : {}),
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user },
      ],
    }),
  });
  if (!response.ok) throw new Error(`Fireworks extraction failed: ${response.status} ${await response.text()}`);

  const payload = (await response.json()) as ChatCompletion;
  const choice = payload.choices[0];
  if (!choice) throw new Error('Fireworks returned no choices');
  // A truncated reply is still valid JSON-so-far but not a complete object;
  // failing loudly beats writing a half-extracted fact.
  if (choice.finish_reason === 'length') throw new Error('extraction hit the token cap before completing');
  if (!choice.message.content) throw new Error(`extraction returned no content (${choice.finish_reason})`);

  return JSON.parse(choice.message.content) as T;
}
