import { describe, expect, it } from 'vitest';
import {
  RECONNECT_MAX_MS,
  initialRecordingState,
  isRecordingActive,
  liveConversationId,
  recordingLabel,
  reconnectDelayMs,
  recordingReducer,
  type RecordingEvent,
  type RecordingState,
} from './recording';

function run(events: RecordingEvent[], from: RecordingState = initialRecordingState): RecordingState {
  return events.reduce(recordingReducer, from);
}

const streaming = () => run([
  { type: 'start', conversationId: 'c-1' },
  { type: 'permission-granted' },
  { type: 'connected' },
]);

describe('recording state machine', () => {
  it('walks idle to streaming through permission and connect', () => {
    let state = recordingReducer(initialRecordingState, { type: 'start', conversationId: 'c-1' });
    expect(state.status).toBe('requesting-permission');
    state = recordingReducer(state, { type: 'permission-granted' });
    expect(state.status).toBe('connecting');
    state = recordingReducer(state, { type: 'connected' });
    expect(state.status).toBe('streaming');
    expect(liveConversationId(state)).toBe('c-1');
  });

  it('carries the reason in the error state rather than losing it', () => {
    const state = run([{ type: 'start', conversationId: 'c-1' }, { type: 'permission-denied' }]);
    expect(state.status).toBe('error');
    expect(state.error).toEqual({
      code: 'permission-denied',
      message: 'Amelia needs microphone access to listen.',
    });
    expect(recordingLabel(state)).toBe('Amelia needs microphone access to listen.');
  });

  /**
   * The old code re-minted the session id on every error render, and that id was a
   * dependency of the effect that set it — mic denial spun the whole tree.
   */
  it('settles on error instead of looping', () => {
    const first = run([{ type: 'start', conversationId: 'c-1' }, { type: 'permission-denied' }]);
    const again = recordingReducer(first, { type: 'permission-denied' });
    expect(again).toBe(first);
  });

  it('keeps the conversation addressable while stopping, then clears it', () => {
    const stopping = recordingReducer(streaming(), { type: 'stop' });
    expect(stopping.status).toBe('stopping');
    expect(liveConversationId(stopping)).toBe('c-1');

    const done = recordingReducer(stopping, { type: 'grace-elapsed' });
    expect(done.status).toBe('idle');
    expect(liveConversationId(done)).toBeNull();
  });

  /**
   * The grace period used to be a bare setTimeout that fired regardless, so stopping
   * and starting again inside eight seconds killed the new session's live state.
   */
  it('a new session cancels the previous grace period', () => {
    const stopping = recordingReducer(streaming(), { type: 'stop' });
    const restarted = recordingReducer(stopping, { type: 'start', conversationId: 'c-2' });
    expect(restarted.status).toBe('requesting-permission');

    const stale = recordingReducer(restarted, { type: 'grace-elapsed' });
    expect(stale).toBe(restarted);
    expect(stale.conversationId).toBe('c-2');
  });

  it('goes to reconnecting on a drop and counts the attempt', () => {
    const lost = recordingReducer(streaming(), {
      type: 'connection-lost',
      reason: 'connection-lost',
      message: 'the socket closed',
    });
    expect(lost.status).toBe('reconnecting');
    expect(lost.attempt).toBe(1);
    expect(isRecordingActive(lost)).toBe(true);
    // Still the same conversation: reconnecting is not a new session.
    expect(liveConversationId(lost)).toBe('c-1');
  });

  it('resets the backoff once the socket is back', () => {
    let state = streaming();
    state = recordingReducer(state, { type: 'connection-lost', reason: 'connection-lost', message: 'x' });
    state = recordingReducer(state, { type: 'retry' });
    state = recordingReducer(state, { type: 'connected' });
    expect(state.status).toBe('streaming');
    expect(state.attempt).toBe(0);
  });

  it('reports how much audio is being held during a drop', () => {
    let state = recordingReducer(streaming(), { type: 'connection-lost', reason: 'connection-lost', message: 'x' });
    state = recordingReducer(state, { type: 'buffered', frames: 12 });
    expect(state.bufferedFrames).toBe(12);
  });

  it('takes an error straight back to idle when stopped', () => {
    const failed = run([{ type: 'start', conversationId: 'c-1' }, { type: 'permission-denied' }]);
    expect(recordingReducer(failed, { type: 'stop' }).status).toBe('idle');
  });

  it('ignores events that do not belong to the current status', () => {
    expect(recordingReducer(initialRecordingState, { type: 'connected' })).toBe(initialRecordingState);
    expect(recordingReducer(initialRecordingState, { type: 'permission-granted' })).toBe(initialRecordingState);
  });
});

describe('reconnect backoff', () => {
  it('doubles from the base and stops at the ceiling', () => {
    expect(reconnectDelayMs(1)).toBe(500);
    expect(reconnectDelayMs(2)).toBe(1_000);
    expect(reconnectDelayMs(3)).toBe(2_000);
    expect(reconnectDelayMs(4)).toBe(4_000);
    expect(reconnectDelayMs(5)).toBe(8_000);
    expect(reconnectDelayMs(20)).toBe(RECONNECT_MAX_MS);
  });
});
