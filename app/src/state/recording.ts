import type { Id } from '../../../shared/contracts';

/**
 * The one description of "are we recording". Everything else — which conversation
 * is live, whether the transcript says "Listening now", what the mic button reads —
 * is derived from this, so there is nothing left to disagree with.
 *
 * `stopping` is a real state rather than a stray timer: the server finalises trailing
 * turns after the socket closes, so the session id has to stay addressable for a
 * grace period. Starting again cancels that grace, which is what a bare setTimeout
 * could not do.
 */
export type RecordingStatus =
  | 'idle'
  | 'requesting-permission'
  | 'connecting'
  | 'streaming'
  | 'reconnecting'
  | 'stopping'
  | 'error';

export type RecordingErrorCode =
  | 'permission-denied'
  | 'connect-timeout'
  | 'connection-lost'
  | 'capture-failed'
  | 'backgrounded'
  | 'mic-busy'
  | 'unknown';

export interface RecordingError {
  code: RecordingErrorCode;
  message: string;
}

export interface RecordingState {
  status: RecordingStatus;
  /** The conversation this session writes into. Survives `stopping` so trailing turns land. */
  conversationId: Id | null;
  /** Only ever set alongside `status: 'error'`; cleared by every other transition. */
  error: RecordingError | null;
  /** How many consecutive reconnects have been attempted. Reset by a clean open. */
  attempt: number;
  /** Frames held back while the socket is down, so a drop does not lose speech. */
  bufferedFrames: number;
}

export const initialRecordingState: RecordingState = {
  status: 'idle',
  conversationId: null,
  error: null,
  attempt: 0,
  bufferedFrames: 0,
};

export type RecordingEvent =
  | { type: 'start'; conversationId: Id }
  | { type: 'permission-granted' }
  | { type: 'permission-denied' }
  | { type: 'connected' }
  | { type: 'capturing' }
  | { type: 'connection-lost'; reason: RecordingErrorCode; message: string }
  | { type: 'retry' }
  | { type: 'buffered'; frames: number }
  | { type: 'stop' }
  | { type: 'stopped' }
  | { type: 'grace-elapsed' }
  | { type: 'failed'; error: RecordingError };

const ACTIVE: RecordingStatus[] = ['requesting-permission', 'connecting', 'streaming', 'reconnecting'];

/** True while this session owns the microphone and is writing into its conversation. */
export function isRecordingActive(state: RecordingState): boolean {
  return ACTIVE.includes(state.status);
}

/**
 * The conversation the UI should treat as live. `stopping` still counts: the
 * transcript stays pinned to it while the server flushes the tail.
 */
export function liveConversationId(state: RecordingState): Id | null {
  if (state.status === 'idle' || state.status === 'error') return null;
  return state.conversationId;
}

export function recordingReducer(state: RecordingState, event: RecordingEvent): RecordingState {
  switch (event.type) {
    case 'start':
      // A start always begins a fresh session, including out of `stopping` — which is
      // what cancels the grace period rather than letting it kill the new session.
      return {
        status: 'requesting-permission',
        conversationId: event.conversationId,
        error: null,
        attempt: 0,
        bufferedFrames: 0,
      };

    case 'permission-granted':
      if (state.status !== 'requesting-permission') return state;
      return { ...state, status: 'connecting', error: null };

    case 'permission-denied':
      if (state.status !== 'requesting-permission') return state;
      return {
        ...state,
        status: 'error',
        error: { code: 'permission-denied', message: 'Amelia needs microphone access to listen.' },
      };

    case 'connected':
      if (state.status !== 'connecting' && state.status !== 'reconnecting') return state;
      // Reaching the server clears the backoff, so a long session that blips twice an
      // hour never inherits an hour-long delay.
      return { ...state, status: 'streaming', attempt: 0, error: null };

    case 'capturing':
      if (state.status !== 'connecting' && state.status !== 'streaming') return state;
      return { ...state, status: 'streaming', error: null };

    case 'connection-lost':
      if (!isRecordingActive(state)) return state;
      return {
        ...state,
        status: 'reconnecting',
        error: null,
        attempt: state.attempt + 1,
      };

    case 'retry':
      if (state.status !== 'reconnecting') return state;
      return { ...state, status: 'connecting' };

    case 'buffered':
      return { ...state, bufferedFrames: event.frames };

    case 'stop':
      if (state.status === 'idle' || state.status === 'stopping') return state;
      // An error has nothing to flush, so it goes straight to idle.
      if (state.status === 'error') return { ...initialRecordingState };
      return { ...state, status: 'stopping', error: null, bufferedFrames: 0 };

    case 'stopped':
      if (state.status !== 'stopping') return state;
      return state;

    case 'grace-elapsed':
      if (state.status !== 'stopping') return state;
      return { ...initialRecordingState };

    case 'failed':
      if (state.status === 'idle') return state;
      return { ...state, status: 'error', error: event.error, bufferedFrames: 0 };

    default:
      return state;
  }
}

/** Exponential backoff with a ceiling, so a server that is down does not spin the radio. */
export const RECONNECT_BASE_MS = 500;
export const RECONNECT_MAX_MS = 8_000;
export const RECONNECT_MAX_ATTEMPTS = 6;
/** A socket that has not opened by here is not going to; "Connecting" must not hang. */
export const CONNECT_TIMEOUT_MS = 6_000;
/** How long a stopped session stays addressable while the server flushes its tail. */
export const STOP_GRACE_MS = 8_000;

export function reconnectDelayMs(attempt: number): number {
  return Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.max(0, attempt - 1));
}

/** Human copy for the mic control. Kept beside the machine so no screen invents its own. */
export function recordingLabel(state: RecordingState): string {
  switch (state.status) {
    case 'requesting-permission':
      return 'Asking for the mic';
    case 'connecting':
      return 'Connecting';
    case 'streaming':
      return 'Listening';
    case 'reconnecting':
      return 'Reconnecting';
    case 'stopping':
      return 'Wrapping up';
    case 'error':
      return state.error?.message ?? 'Something went wrong';
    default:
      return 'Start listening';
  }
}
