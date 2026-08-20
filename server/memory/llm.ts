import { EXTRACTION_MODEL } from '../../shared/contracts';
import { fireworksBaseUrl, fireworksKey } from './fireworks';
import { providerFailure, RetryableProviderError, withProviderRetry } from './retry';

export interface ExtractionRequest {
  system: string;
  user: string;
  /** JSON Schema the reply is constrained to; objects need `additionalProperties: false`. */
  schema: Record<string, unknown>;
  maxTokens?: number;
  /**
   * How hard the model thinks before it writes. The reply itself is small
   * either way; this is the size of the hidden reasoning that precedes it, and
   * it is what the token budget is actually spent on.
   */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /**
   * Offered the raw reply when the token cap cut it off, and returns whatever
   * is worth keeping — or `undefined` to fail as usual. Extraction writes facts
   * to a permanent store and must not keep half of one, so leaving this unset
   * still throws. A caller composing something for a person to read can pass
   * `parseSalvageable` and learn, from being called at all, that what it got
   * back is only part of an answer.
   */
  salvageTruncated?: (partial: string) => unknown;
}

interface ChatCompletion {
  choices: Array<{ message: { content: string | null }; finish_reason: string }>;
}

/** Thrown when the reply was cut off and nothing usable could be recovered from it. */
export class TokenCapError extends Error {
  constructor(readonly partial: string) {
    super('extraction hit the token cap before completing');
    this.name = 'TokenCapError';
  }
}

interface CutPoint {
  end: number;
  closers: string;
}

const CLOSER = { '{': '}', '[': ']' } as const;

/**
 * Every position a truncated JSON document could be cut back to.
 *
 * A cut is only safe where the document is between values rather than partway
 * through one: after a closing quote, after a closing bracket, before a comma,
 * or immediately inside a container that turned out to be its last. Each point
 * remembers the brackets still open there, so the prefix can be closed without
 * a second scan.
 */
function cutPoints(text: string): CutPoint[] {
  const points: CutPoint[] = [];
  const open: Array<'{' | '['> = [];
  const closers = (): string =>
    open
      .map((bracket) => CLOSER[bracket])
      .reverse()
      .join('');
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') {
        inString = false;
        points.push({ end: index + 1, closers: closers() });
      }
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{' || character === '[') {
      open.push(character);
      points.push({ end: index + 1, closers: closers() });
    } else if (character === '}' || character === ']') {
      open.pop();
      points.push({ end: index + 1, closers: closers() });
    } else if (character === ',') points.push({ end: index, closers: closers() });
  }
  return points;
}

/**
 * Parse as much of a cut-off JSON document as still forms a whole object.
 *
 * The reply arrives in schema order, so a truncated one has whole leading
 * fields and nothing after them. Working backwards from the end, the first
 * prefix that closes into valid JSON is the most that survived. Half-written
 * strings are never closed: a sentence that stops mid-word is not something to
 * hand back as if it were finished.
 */
export function parseSalvageable<T>(text: string): T | undefined {
  const points = cutPoints(text);
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const point = points[index]!;
    try {
      return JSON.parse(text.slice(0, point.end) + point.closers) as T;
    } catch {
      continue;
    }
  }
  return undefined;
}

async function requestCompletion<T>(request: ExtractionRequest): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${fireworksBaseUrl()}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${fireworksKey()}` },
      body: JSON.stringify({
        model: EXTRACTION_MODEL,
        max_tokens: request.maxTokens ?? 4_000,
        temperature: 0,
        ...(request.reasoningEffort ? { reasoning_effort: request.reasoningEffort } : {}),
        response_format: { type: 'json_object', schema: request.schema },
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user },
        ],
      }),
    });
  } catch (error) {
    // A dropped connection is indistinguishable from an overloaded backend
    // from here, and both are worth another attempt.
    throw new RetryableProviderError(`Fireworks extraction failed to connect: ${String(error)}`);
  }

  if (!response.ok) {
    const detail = `Fireworks extraction failed: ${response.status} ${await response.text()}`;
    throw providerFailure(response.status, detail, response.headers);
  }

  const payload = (await response.json()) as ChatCompletion;
  const choice = payload.choices[0];
  if (!choice) throw new Error('Fireworks returned no choices');
  // A truncated reply is still valid JSON-so-far but not a complete object.
  // Failing loudly beats writing a half-extracted fact, so only a caller that
  // said what a partial reply is worth to it gets one back.
  if (choice.finish_reason === 'length') {
    const partial = choice.message.content ?? '';
    const salvaged = request.salvageTruncated?.(partial);
    if (salvaged !== undefined) return salvaged as T;
    throw new TokenCapError(partial);
  }
  if (!choice.message.content) throw new Error(`extraction returned no content (${choice.finish_reason})`);

  return JSON.parse(choice.message.content) as T;
}

/**
 * Structured output rather than a tool-use loop: the passes want one
 * schema-valid object, not an agent. Fireworks constrains decoding to the
 * schema, so the reply cannot drift from the shape and there is no
 * parse-retry path to maintain.
 */
export async function extractStructured<T>(request: ExtractionRequest): Promise<T> {
  return withProviderRetry(() => requestCompletion<T>(request));
}
