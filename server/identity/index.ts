import type { Hono } from 'hono';
import type { ServerDependencies } from '../../shared/contracts';

/** Lane A replaces this scaffold without changing the import in server/index.ts. */
export function registerIdentityRoutes(_app: Hono, _deps: ServerDependencies): void {}
