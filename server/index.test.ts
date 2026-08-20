import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createApp, isDirectRun } from './index';

const here = dirname(fileURLToPath(import.meta.url));
const moduleUrl = pathToFileURL(resolve(here, 'index.ts')).href;

describe('Lane 0 server scaffold', () => {
  it('reports health', async () => {
    const { app } = createApp();
    const response = await app.request('/health');
    expect(response.status).toBe(200);
    // Health names the live storage backend. It used to answer a flat
    // {ok:true} even with a dead database, which is the one situation the
    // check exists to reveal.
    const body = (await response.json()) as {
      ok: boolean;
      service: string;
      storage: { driver: string; degraded?: boolean };
    };
    expect(body.ok).toBe(true);
    expect(body.service).toBe('amelia');
    expect(body.storage.driver).toBe('local');
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

  it('detects tsx and node entrypoints without starting under vitest', () => {
    expect(isDirectRun(['node', resolve(here, 'index.ts')], moduleUrl)).toBe(true);
    expect(isDirectRun(['node', '/usr/local/bin/tsx', 'index.ts'], moduleUrl)).toBe(true);
    expect(isDirectRun(['node', '/usr/local/bin/tsx', 'watch', 'index.ts'], moduleUrl)).toBe(true);
    expect(isDirectRun(process.argv, moduleUrl)).toBe(false);
  });
});

describe('reconnect', () => {
  /** Read one SSE chunk, then let go. */
  async function firstChunk(response: Response): Promise<string> {
    const reader = response.body!.getReader();
    const { value } = await reader.read();
    void reader.cancel();
    return new TextDecoder().decode(value);
  }

  const utterance = (text: string) => ({
    type: 'utterance' as const,
    utterance_id: `u-${text}`,
    conversation_id: 'c-1',
    text,
    start_ms: 0,
    end_ms: 10,
    is_final: true,
  });

  it('numbers events so a client can tell the server where it stopped', async () => {
    const { app, deps } = createApp();
    deps.bus.emit(utterance('one'));
    const body = await firstChunk(await app.request('/events'));
    expect(body).toMatch(/^id: 1\n/);
  });

  it('replays what a reconnecting client missed, via Last-Event-ID', async () => {
    // react-native-sse records the `id:` of the last event it saw and sends it
    // back automatically, so a phone that loses wifi mid-conversation resumes
    // instead of leaving a hole in the transcript that no reload explains.
    const { app, deps } = createApp();
    deps.bus.emit(utterance('before-the-drop'));
    deps.bus.emit(utterance('during-the-drop'));

    const body = await firstChunk(
      await app.request('/events', { headers: { 'Last-Event-ID': '1' } }),
    );
    expect(body).toContain('u-during-the-drop');
    expect(body).not.toContain('u-before-the-drop');
  });

  it('accepts ?since= for clients that cannot set the header', async () => {
    const { app, deps } = createApp();
    deps.bus.emit(utterance('old'));
    deps.bus.emit(utterance('new'));
    const body = await firstChunk(await app.request('/events?since=1'));
    expect(body).toContain('u-new');
    expect(body).not.toContain('u-old');
  });
});
