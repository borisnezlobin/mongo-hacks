import { useCallback, useEffect, useMemo, useRef } from 'react';
import { AppState, Platform, type AppStateStatus } from 'react-native';
import type { Id, StreamHandshake } from '../../shared/contracts';
import { streamUrl } from '../src/lib/urls';
import { useActions } from '../src/state/store';
import { useRecordingState } from '../src/state/hooks';
import { STOP_GRACE_MS, type RecordingState } from '../src/state/recording';
import { useAudioSession } from './audio-session';
import { CaptureEngine, type CaptureSocket } from './capture-engine';

/**
 * iOS can legitimately keep capturing with the audio background mode declared, so a
 * backgrounded recording continues. Android would need a foreground service, which this
 * build does not ship — so it stops cleanly and says so, instead of dying quietly and
 * surfacing later as a generic "Couldn't start".
 */
const KEEPS_RECORDING_IN_BACKGROUND = Platform.OS === 'ios';

export interface RecordingControls {
  state: RecordingState;
  start(): Promise<void>;
  stop(): void;
}

function newConversationId(): Id {
  return `c-${Date.now()}`;
}

export function useAudioCapture(): RecordingControls {
  const actions = useActions();
  const session = useAudioSession();
  const state = useRecordingState();

  const engineRef = useRef<CaptureEngine | null>(null);
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const sessionRef = useRef(session);
  sessionRef.current = session;

  if (!engineRef.current) {
    engineRef.current = new CaptureEngine({
      openSocket(conversationId, handlers): CaptureSocket {
        const socket = new WebSocket(streamUrl());
        socket.onopen = () => {
          const handshake: StreamHandshake = { conversation_id: conversationId };
          socket.send(JSON.stringify(handshake));
          handlers.onOpen();
        };
        socket.onerror = () => handlers.onClose('the socket reported an error');
        socket.onclose = () => handlers.onClose('the socket closed');
        return {
          send: (frame) => socket.send(frame),
          close: () => socket.close(),
        };
      },
      acquireMicrophone: (onSamples) => sessionRef.current.acquire('capture', onSamples),
      releaseMicrophone: () => sessionRef.current.release('capture'),
      emit: (event) => actionsRef.current.recording(event),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    });
  }
  const engine = engineRef.current;

  const start = useCallback(async () => {
    await engine.start(newConversationId());
  }, [engine]);

  const stop = useCallback(() => {
    engine.stop();
  }, [engine]);

  /**
   * The grace period is a state, not a stray timer. A start inside it changes the
   * status, which cancels this one — the old unconditional setTimeout killed the live
   * state of whatever session happened to be running eight seconds later.
   */
  useEffect(() => {
    if (state.status !== 'stopping') return;
    const timer = setTimeout(() => actionsRef.current.recording({ type: 'grace-elapsed' }), STOP_GRACE_MS);
    return () => clearTimeout(timer);
  }, [state.status]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (next !== 'background' || KEEPS_RECORDING_IN_BACKGROUND) return;
      engine.interrupt('backgrounded', 'Recording stopped when Amelia went to the background.');
    });
    return () => subscription.remove();
  }, [engine]);

  useEffect(() => () => engine.stop(), [engine]);

  return useMemo(() => ({ state, start, stop }), [state, start, stop]);
}
