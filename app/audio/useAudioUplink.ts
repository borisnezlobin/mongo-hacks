import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { requestRecordingPermissionsAsync, useAudioStream } from 'expo-audio';
import type { AudioStreamBuffer, AudioStreamEncoding, AudioStreamOptions } from 'expo-audio';
import type { AudioUplink, Id, StreamHandshake } from '../../shared/contracts';
import { AUDIO_FRAME_SAMPLES } from '../../shared/contracts';
import { int16ToFloat32, resampleTo16k } from './resample';

/**
 * expo-audio's `useAudioStream` (verified against
 * node_modules/expo-audio/build/AudioStream.types.d.ts and ExpoAudio.d.ts in this
 * install of expo-audio ~57.0.3) delivers real, native PCM buffers to JS through an
 * `onBuffer` callback — this is not a seam or a silence fallback. We request
 * float32 mono at 16 kHz directly, which is the wire format the server expects, so
 * the common case needs no conversion at all. The encoding is still typed as the
 * full union (not narrowed to the literal) so the defensive int16 branch below
 * type-checks in case a future platform quirk ever delivers int16 despite the
 * request.
 */
const STREAM_ENCODING: AudioStreamEncoding = 'float32';

/** Base API origin, converted from http(s) to ws(s) with the /stream path appended. */
function buildStreamUrl(): string {
  const base = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';
  const wsBase = base.replace(/^http/, 'ws').replace(/\/$/, '');
  return `${wsBase}/stream`;
}

function concatFloat32(a: Float32Array, b: Float32Array): Float32Array {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Copies a Float32Array frame into a standalone ArrayBuffer sized to exactly its bytes. */
function frameToArrayBuffer(frame: Float32Array): ArrayBuffer {
  return frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) as ArrayBuffer;
}

/**
 * Streams the device microphone to Amelia's /stream websocket as uplink-only PCM.
 * State machine: idle -> connecting (start called) -> streaming (socket open AND
 * capture running) -> idle (stop) or error (any failure, which also tears down
 * both the socket and the capture session).
 */
export default function useAudioUplink(conversationId: string): AudioUplink {
  const [state, setStateValue] = useState<AudioUplink['state']>('idle');
  const stateRef = useRef(state);
  const setState = useCallback((next: AudioUplink['state']) => {
    stateRef.current = next;
    setStateValue(next);
  }, []);

  const mountedRef = useRef(true);
  const socketRef = useRef<WebSocket | null>(null);
  const captureStartedRef = useRef(false);
  const readyRef = useRef(false);
  const intentionalCloseRef = useRef(false);
  const pendingRef = useRef<Float32Array<ArrayBufferLike>>(new Float32Array(0));

  /** Stops capture and closes the socket. Does not touch React state. */
  const teardown = useCallback(() => {
    readyRef.current = false;

    if (socketRef.current) {
      intentionalCloseRef.current = true;
      try {
        socketRef.current.close();
      } catch {
        // Socket may already be closed or never opened; nothing else to do.
      }
      socketRef.current = null;
    }

    if (captureStartedRef.current) {
      try {
        stream.stop();
      } catch {
        // Native capture may already have stopped.
      }
      captureStartedRef.current = false;
    }

    pendingRef.current = new Float32Array(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFailure = useCallback(() => {
    teardown();
    if (mountedRef.current) {
      setState('error');
    }
  }, [teardown, setState]);

  /** Buffers PCM frames until a full AUDIO_FRAME_SAMPLES chunk is ready, then sends it. */
  const handleBuffer = useCallback((buffer: AudioStreamBuffer) => {
    if (!readyRef.current || !socketRef.current) return;

    const raw =
      STREAM_ENCODING === 'int16'
        ? int16ToFloat32(new Int16Array(buffer.data))
        : new Float32Array(buffer.data);
    const resampled = resampleTo16k(raw, buffer.sampleRate);
    pendingRef.current = concatFloat32(pendingRef.current, resampled);

    while (pendingRef.current.length >= AUDIO_FRAME_SAMPLES) {
      const frame = pendingRef.current.subarray(0, AUDIO_FRAME_SAMPLES);
      try {
        socketRef.current.send(frameToArrayBuffer(frame));
      } catch {
        handleFailure();
        return;
      }
      pendingRef.current = pendingRef.current.slice(AUDIO_FRAME_SAMPLES);
    }
  }, [handleFailure]);

  const streamOptions = useMemo<AudioStreamOptions>(
    () => ({
      sampleRate: 16_000,
      channels: 1,
      encoding: STREAM_ENCODING,
      onBuffer: handleBuffer,
    }),
    [handleBuffer],
  );

  const { stream } = useAudioStream(streamOptions);

  /** Opens the uplink socket and sends the handshake once it connects. */
  const openSocket = useCallback((id: Id): Promise<WebSocket> => {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(buildStreamUrl());
      let settled = false;

      socket.onopen = () => {
        const handshake: StreamHandshake = { conversation_id: id };
        socket.send(JSON.stringify(handshake));
        settled = true;
        resolve(socket);
      };

      socket.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new Error('Audio uplink socket failed to connect'));
        } else {
          handleFailure();
        }
      };

      socket.onclose = () => {
        if (settled && !intentionalCloseRef.current) {
          handleFailure();
        }
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleFailure]);

  const start = useCallback(async () => {
    if (stateRef.current === 'connecting' || stateRef.current === 'streaming') {
      return;
    }

    teardown();
    intentionalCloseRef.current = false;
    setState('connecting');

    try {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        throw new Error('Microphone permission was not granted');
      }

      const socket = await openSocket(conversationId);
      socketRef.current = socket;

      await stream.start();
      captureStartedRef.current = true;
      readyRef.current = true;

      if (mountedRef.current) {
        setState('streaming');
      }
    } catch (err) {
      teardown();
      if (mountedRef.current) {
        setState('error');
      }
      throw err;
    }
  }, [conversationId, openSocket, stream, teardown, setState]);

  const stop = useCallback(async () => {
    teardown();
    if (mountedRef.current) {
      setState('idle');
    }
  }, [teardown, setState]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      teardown();
    };
  }, [teardown]);

  return { state, start, stop };
}
