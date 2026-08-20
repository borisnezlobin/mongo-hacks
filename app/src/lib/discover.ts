import { API_CANDIDATES, HEALTH_TIMEOUT_MS } from './config';
import { setApiBase } from './urls';

/**
 * Find which candidate address actually answers.
 *
 * All candidates are probed at once rather than in order, because the failing
 * ones fail slowly: an address on a network that isolates its clients does not
 * refuse the connection, it hangs until the timeout. Trying them in sequence
 * would spend that timeout once per candidate before reaching the one that
 * works, which on a cold start is the difference between a transcript and a
 * blank screen.
 *
 * First healthy answer wins. If none answer we keep the first candidate, so the
 * app behaves exactly as it did before discovery existed and the connectivity
 * banner still tells the truth.
 */
export async function discoverApiBase(): Promise<string | undefined> {
  // Nothing to choose between, and the health probe the app already does on
  // startup will say whether that one address works.
  if (API_CANDIDATES.length <= 1) return undefined;

  const found = await Promise.race([
    ...API_CANDIDATES.map(async (candidate) => {
      const ok = await probe(candidate);
      // Losing candidates never resolve, so Promise.race settles on the first
      // that is actually reachable rather than the first to finish.
      return ok ? candidate : await new Promise<string>(() => {});
    }),
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), HEALTH_TIMEOUT_MS + 500)),
  ]);

  if (found) setApiBase(found);
  return found;
}

async function probe(base: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(`${base}/health`, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
