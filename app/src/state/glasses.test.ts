import { describe, expect, it } from 'vitest';
import type { GlassesStatus } from '../../../shared/contracts';
import { glassesReducer, initialGlassesState, type GlassesFrameView } from './glasses';

const status: GlassesStatus = {
  type: 'status', ts_ms: 1_000, die_c: 52, camera: 'burst', vad: true,
  fps: 7.5, audio_drops: 0, frame_drops: 2, heap_free: 1, psram_free: 2,
};

const frame = (tsMs: number): GlassesFrameView => ({
  ts_ms: tsMs,
  width: 640,
  height: 480,
  tracks: [{ track_id: 't-1', bbox: { x: 0, y: 0, width: 0.3, height: 0.3 }, is_near: true, is_active_speaker: true }],
});

describe('glasses slice', () => {
  it('holds the newest status and throughput', () => {
    const state = glassesReducer(initialGlassesState, { type: 'glasses-status', status, kbps: 240 });
    expect(state.lastStatus?.die_c).toBe(52);
    expect(state.kbps).toBe(240);
  });

  /** A frame holds a JPEG. Keeping a list of them would grow without bound. */
  it('replaces the last frame rather than accumulating frames', () => {
    let state = glassesReducer(initialGlassesState, { type: 'glasses-frame', frame: frame(1), prerollFillMs: 900 });
    state = glassesReducer(state, { type: 'glasses-frame', frame: frame(2), prerollFillMs: 1_800 });
    expect(state.lastFrame?.ts_ms).toBe(2);
    expect(state.prerollFillMs).toBe(1_800);
  });

  it('tracks whether a conversation is running', () => {
    let state = glassesReducer(initialGlassesState, {
      type: 'glasses-session', state: 'recording', conversationId: 'c-1',
    });
    expect(state.conversationActive).toBe(true);
    expect(state.conversationId).toBe('c-1');
    state = glassesReducer(state, { type: 'glasses-session', state: 'idle' });
    expect(state.conversationActive).toBe(false);
    expect(state.conversationId).toBeUndefined();
  });

  it('losing the link drops everything observed but keeps the owner pin', () => {
    let state = glassesReducer(initialGlassesState, { type: 'glasses-status', status });
    state = glassesReducer(state, { type: 'glasses-mode', mode: 'street', pinned: true });
    state = glassesReducer(state, { type: 'glasses-frame', frame: frame(1) });
    state = glassesReducer(state, { type: 'glasses-link', status: 'disconnected' });

    expect(state.lastStatus).toBeUndefined();
    expect(state.lastFrame).toBeUndefined();
    expect(state.mode).toBe('street');
    expect(state.pinned).toBe(true);
  });

  it('keeps the last owner check and observation for the dev sheet', () => {
    let state = glassesReducer(initialGlassesState, {
      type: 'glasses-owner-check', result: { owner: true, score: 0.81, duration_ms: 3_000 },
    });
    state = glassesReducer(state, {
      type: 'glasses-observation',
      response: { track_id: 't-1', decision: 'matched', confidence: 'confirmed', person_id: 'p-1' },
    });
    expect(state.lastOwnerCheck?.owner).toBe(true);
    expect(state.lastObservation?.person_id).toBe('p-1');
  });
});
