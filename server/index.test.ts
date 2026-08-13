import { describe, expect, it, vi } from 'vitest';
import { createApp } from './index';

describe('Lane 0 server scaffold', () => {
  it('reports health', async () => {
    const { app } = createApp();
    const response = await app.request('/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: 'amelia' });
  });

  it('injects a finalized utterance through the shared bus', async () => {
    const { app, deps } = createApp();
    const listener = vi.fn();
    deps.bus.subscribe(listener);
    const response = await app.request('/debug/utterance', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        utterance_id: 'u1',
        conversation_id: 'c1',
        text: 'Hello from the fixture',
        start_ms: 0,
        end_ms: 3_100,
      }),
    });

    expect(response.status).toBe(202);
    expect(listener).toHaveBeenCalledWith({
      type: 'utterance',
      utterance_id: 'u1',
      conversation_id: 'c1',
      text: 'Hello from the fixture',
      start_ms: 0,
      end_ms: 3_100,
      is_final: true,
    });
  });
});
