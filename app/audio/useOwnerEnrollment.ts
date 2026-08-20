import { useCallback, useEffect, useRef, useState } from 'react';
import { apiUrl } from '../src/lib/urls';
import { MicrophoneBusyError, useAudioSession } from './audio-session';

/**
 * Owner voice enrollment. Records a fixed window of microphone audio into a float32 PCM
 * buffer — the same wire format as the /stream uplink — then POSTs it to /enroll/audio,
 * where the ECAPA sidecar turns it into a voiceprint.
 *
 * It shares the one arbitrated audio session with live capture rather than opening a
 * second concurrent stream, so starting enrollment while Amelia is listening now fails
 * with a sentence the owner can act on instead of two capture sessions fighting.
 */

export const ENROLL_DURATION_MS = 8_000;

export type EnrollState = 'idle' | 'recording' | 'uploading' | 'done' | 'error';

export function useOwnerEnrollment() {
  const session = useAudioSession();
  const [state, setState] = useState<EnrollState>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const chunksRef = useRef<Float32Array[]>([]);
  const samplesRef = useRef(0);
  const recordingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const stopTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const finish = useCallback(async (name: string) => {
    recordingRef.current = false;
    stopTimer();
    sessionRef.current.release('enrollment');

    const pcm = new Float32Array(samplesRef.current);
    let offset = 0;
    for (const chunk of chunksRef.current) {
      pcm.set(chunk, offset);
      offset += chunk.length;
    }

    setState('uploading');
    try {
      const payload = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer;
      const response = await fetch(apiUrl('/enroll/audio', { name, owner: '1' }), {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: payload,
      });
      if (!response.ok) throw new Error(`The server refused the recording (${response.status}).`);
      setState('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState('error');
    }
  }, []);

  const start = useCallback(async (name: string) => {
    setError(null);
    chunksRef.current = [];
    samplesRef.current = 0;
    setProgress(0);

    try {
      recordingRef.current = true;
      await sessionRef.current.acquire('enrollment', (samples) => {
        if (!recordingRef.current) return;
        chunksRef.current.push(samples);
        samplesRef.current += samples.length;
      });
      setState('recording');
      const startedAt = Date.now();
      timerRef.current = setInterval(() => {
        const elapsed = Date.now() - startedAt;
        setProgress(Math.min(1, elapsed / ENROLL_DURATION_MS));
        if (elapsed >= ENROLL_DURATION_MS) void finish(name);
      }, 100);
    } catch (err) {
      recordingRef.current = false;
      sessionRef.current.release('enrollment');
      setError(err instanceof MicrophoneBusyError
        ? err.message
        : err instanceof Error ? err.message : String(err));
      setState('error');
    }
  }, [finish]);

  const reset = useCallback(() => {
    recordingRef.current = false;
    stopTimer();
    sessionRef.current.release('enrollment');
    chunksRef.current = [];
    samplesRef.current = 0;
    setProgress(0);
    setError(null);
    setState('idle');
  }, []);

  useEffect(() => () => {
    recordingRef.current = false;
    stopTimer();
    sessionRef.current.release('enrollment');
  }, []);

  return { state, progress, error, start, reset };
}
