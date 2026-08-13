import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-5';

let client: Anthropic | undefined;

function getClient(): Anthropic {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is required for extraction');
    client = new Anthropic();
  }
  return client;
}

export interface ExtractionRequest {
  system: string;
  user: string;
  /** JSON Schema the reply is constrained to; objects need `additionalProperties: false`. */
  schema: Record<string, unknown>;
  /** Extraction is mechanical — `low` keeps the passes fast enough to run per turn. */
  effort?: 'low' | 'medium' | 'high';
}

/**
 * Structured outputs rather than a tool-use loop: the passes want one
 * schema-valid object, not an agent. The reply cannot drift from the shape,
 * so there is no parse-retry path to maintain.
 *
 * (Sampling parameters are not accepted on this model — the schema constraint
 * is what makes the output stable, not a temperature of zero.)
 */
export async function extractStructured<T>(request: ExtractionRequest): Promise<T> {
  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: 4_000,
    system: request.system,
    output_config: {
      effort: request.effort ?? 'low',
      format: { type: 'json_schema', schema: request.schema },
    },
    messages: [{ role: 'user', content: request.user }],
  });

  if (response.stop_reason === 'refusal') throw new Error('extraction refused by safety classifier');
  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
  if (!text) throw new Error(`extraction returned no text (stop_reason: ${response.stop_reason})`);
  return JSON.parse(text) as T;
}
