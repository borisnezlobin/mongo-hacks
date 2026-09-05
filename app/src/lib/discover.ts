import { API_CANDIDATES, HEALTH_TIMEOUT_MS } from './config';
import { savedApiBase } from './settings';
import { setApiBase } from './urls';

/**
 * The address the owner typed goes first.
 *
 * Not merely added to the pile: a saved base is a deliberate answer to "where
 * is the server", and probing it alongside a stale bundled candidate that
 * happens to answer faster would quietly overrule them.
 */
export function candidateBases(): string[] {
  const saved = savedApiBase();
  const rest = API_CANDIDATES.filter((candidate) => candidate !== saved);
  return saved ? [saved, ...rest] : [...rest];
}

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
  const candidates = candidateBases();
  // Nothing to choose between, and the health probe the app already does on
  // startup will say whether that one address works.
  if (candidates.length <= 1) {
    if (candidates[0]) setApiBase(candidates[0]);
    return undefined;
  }

  const found = await Promise.race([
    ...candidates.map(async (candidate) => {
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
