import { createHash, timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';

/**
 * Opt-in shared-secret auth for the HTTP surface. With AMELIA_API_KEY unset —
 * every checkout today — this is a no-op and nothing changes. With it set,
 * every route except /health requires `Authorization: Bearer <key>`, which is
 * what an external caller (siyi already sends this header) uses once an
 * Amelia instance leaves localhost.
 *
 * Covers the Hono routes only: the /stream WebSocket upgrade happens outside
 * Hono in attachAudioStream and stays open. So does the glasses Express
 * server. Both are localhost-only concerns until someone deploys this, and
 * closing them belongs to whoever does.
 */
export function bearerAuth(expectedKey?: string): MiddlewareHandler {
  return async (context, next) => {
    const key = expectedKey ?? process.env.AMELIA_API_KEY;
    if (!key || context.req.path === '/health') return next();

    const header = context.req.header('authorization') ?? '';
    const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    if (!token || !safeEqual(token, key)) {
      return context.json({ error: 'unauthorized' }, 401);
    }
    return next();
  };
}

/** Hashing first makes the comparison constant-time for unequal lengths too. */
function safeEqual(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}
