import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { FaceObservationRequest, FaceObservationResponse } from '../shared/contracts';

/** The one network call the face lane makes. Everything else here is real. */
const sidecar = vi.hoisted(() => ({ embedFaceJpeg: vi.fn(), detectFacesJpeg: vi.fn(), isNoFace: vi.fn(() => false) }));
vi.mock('./faces/embed-client', () => sidecar);

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

describe('a face crop arriving from the glasses', () => {
  const observation = (overrides: Partial<FaceObservationRequest> = {}): FaceObservationRequest => ({
    frame_ts_ms: 0,
    frame_seq: 0,
    track_id: 't1',
    bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.3 },
    is_near: true,
    is_active_speaker: false,
    crop_jpeg_base64: Buffer.from('a jpeg, as far as this test is concerned').toString('base64'),
    ...overrides,
  });

  const observe = async (body: FaceObservationRequest) => {
    const { app } = createApp();
    return app.request('/faces/observe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  };

  it('matches a stranger seen outside a conversation without writing anything down', async () => {
    const embedding = new Array<number>(512).fill(0);
    embedding[0] = 1;
    sidecar.embedFaceJpeg.mockResolvedValue({
      vector: embedding,
      det_score: 0.9,
      bbox: { x: 0, y: 0, width: 10, height: 10 },
      elapsed_ms: 5,
    });

    const response = await observe(observation());

    expect(response.status).toBe(200);
    const body = (await response.json()) as FaceObservationResponse;
    expect(body).toMatchObject({ track_id: 't1', decision: 'unknown', confidence: 'pending' });
  });

  it('refuses an observation with no crop in it', async () => {
    const response = await observe(observation({ crop_jpeg_base64: '' }));

    expect(response.status).toBe(400);
  });
});
