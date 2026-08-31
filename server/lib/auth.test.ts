import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { bearerAuth } from './auth';

function appWith(key?: string) {
  const app = new Hono();
  app.use('*', bearerAuth(key));
  app.get('/health', (context) => context.json({ ok: true }));
  app.get('/people', (context) => context.json([]));
  return app;
}

describe('bearerAuth', () => {
  it('passes everything through when no key is configured', async () => {
    const response = await appWith(undefined).request('/people');
    expect(response.status).toBe(200);
  });

  it('rejects a missing or wrong token when a key is set', async () => {
    const app = appWith('secret');
    expect((await app.request('/people')).status).toBe(401);
    const wrong = await app.request('/people', {
      headers: { authorization: 'Bearer nope' },
    });
    expect(wrong.status).toBe(401);
  });

  it('accepts the right token and always leaves /health open', async () => {
    const app = appWith('secret');
    const right = await app.request('/people', {
      headers: { authorization: 'Bearer secret' },
    });
    expect(right.status).toBe(200);
    expect((await app.request('/health')).status).toBe(200);
  });
});
