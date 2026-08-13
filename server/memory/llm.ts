import { EXTRACTION_MODEL } from '../../shared/contracts';
import { fireworksKey, FIREWORKS_BASE_URL } from './fireworks';

export interface ExtractionRequest {
  system: string;
  user: string;
  /** JSON Schema the reply is constrained to; objects need `additionalProperties: false`. */
  schema: Record<string, unknown>;
  maxTokens?: number;
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
  const response = await fetch(`${FIREWORKS_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${fireworksKey()}` },
    body: JSON.stringify({
      model: EXTRACTION_MODEL,
      max_tokens: request.maxTokens ?? 4_000,
      temperature: 0,
      response_format: { type: 'json_object', schema: request.schema },
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
