/**
 * Riding out a shared inference provider's bad minute.
 *
 * A shared provider is overloaded some of the time, and there is nothing the
 * caller can do about it except wait.
 *
 * A three-minute test recording drew a `503 service overloaded` from Fireworks,
 * and the only protection was a single immediate retry one layer up — which
 * against an overloaded backend mostly just asks the same busy machine the same
 * question a moment later. Four attempts with exponential backoff spans about
 * nine seconds of provider trouble, which covers a load spike without turning a
 * real outage into a queue that never drains. The delays are jittered because
 * every conversation being extracted at once would otherwise retry in lockstep.
 *
 * This lives apart from its first caller because extraction was not the only
 * request that needed it. Embeddings had no retry at all, and a single
 * transient 429 there silently drops the semantic half of retrieval for that
 * question — which changes which answering strategy `/ask` picks, with nothing
 * but a `console.warn` to show for it. Two calls to the same provider, one
 * protected and one not, is not a distinction anything was relying on.
 */
export const RETRY_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const RETRY_BASE_MS = 600;
const RETRY_ATTEMPTS = 4;
const MAX_RETRY_DELAY_MS = 20_000;

export class RetryableProviderError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'RetryableProviderError';
  }
}

function backoffMs(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, MAX_RETRY_DELAY_MS);
  const exponential = RETRY_BASE_MS * 2 ** attempt;
  return Math.min(exponential + Math.random() * RETRY_BASE_MS, MAX_RETRY_DELAY_MS);
}

/** `Retry-After` is either seconds or an HTTP date; both are worth honouring. */
export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `attempt` until it stops throwing `RetryableProviderError`.
 *
 * Anything else is the caller's own problem — a bad schema or a rejected key
 * will be rejected identically next time — and is rethrown untouched.
 */
export async function withProviderRetry<T>(attempt: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let index = 0; index < RETRY_ATTEMPTS; index += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (!(error instanceof RetryableProviderError)) throw error;
      lastError = error;
      if (index === RETRY_ATTEMPTS - 1) break;
      await sleep(backoffMs(index, error.retryAfterMs));
    }
  }
  throw lastError;
}

/** The retryable-or-not decision every call to this provider makes the same way. */
export function providerFailure(status: number, detail: string, headers: Headers): Error {
  return RETRY_STATUSES.has(status)
    ? new RetryableProviderError(detail, parseRetryAfter(headers.get('retry-after')))
    : new Error(detail);
}
