import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { requestRecordingPermissionsAsync, useAudioStream } from 'expo-audio';
import type { AudioStreamBuffer, AudioStreamEncoding, AudioStreamOptions } from 'expo-audio';
import { int16ToFloat32, resampleTo16k } from './resample';
import { API_BASE_URL } from '../src/lib/config';

/**
 * Owner voice enrollment. Records a fixed window of microphone audio into a
 * float32 PCM buffer — the same wire format as the /stream uplink — then POSTs
 * it to /enroll/audio where the ECAPA sidecar turns it into a voiceprint and
 * identity attaches it to the owner person. This upgrades "Hey Amelia" from
 * failing closed to actually recognizing the owner's voice.
 */

const STREAM_ENCODING: AudioStreamEncoding = 'float32';
export const ENROLL_DURATION_MS = 8_000;

export type EnrollState = 'idle' | 'recording' | 'uploading' | 'done' | 'error';

export function useOwnerEnrollment() {
  const [state, setState] = useState<EnrollState>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const chunksRef = useRef<Float32Array[]>([]);
  const samplesRef = useRef(0);
  const recordingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const handleBuffer = useCallback((buffer: AudioStreamBuffer) => {
    if (!recordingRef.current) return;
    const raw =
      STREAM_ENCODING === 'int16'
        ? int16ToFloat32(new Int16Array(buffer.data))
        : new Float32Array(buffer.data);
    const resampled = resampleTo16k(raw, buffer.sampleRate);
    chunksRef.current.push(resampled);
    samplesRef.current += resampled.length;
  }, []);

  const streamOptions = useMemo<AudioStreamOptions>(
    () => ({ sampleRate: 16_000, channels: 1, encoding: STREAM_ENCODING, onBuffer: handleBuffer }),
    [handleBuffer],
  );
  const { stream } = useAudioStream(streamOptions);

  const stopTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const finish = useCallback(
    async (name: string) => {
      recordingRef.current = false;
      stopTimer();
      try {
        stream.stop();
      } catch {
        // already stopped
      }

      const total = samplesRef.current;
      const pcm = new Float32Array(total);
      let offset = 0;
      for (const chunk of chunksRef.current) {
        pcm.set(chunk, offset);
        offset += chunk.length;
      }

      setState('uploading');
      try {
        const payload = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer;
        const response = await fetch(
          `${API_BASE_URL}/enroll/audio?name=${encodeURIComponent(name)}&owner=1`,
          { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: payload },
        );
        if (!response.ok) throw new Error(`enroll failed (${response.status})`);
        setState('done');
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setState('error');
      }
    },
    [stream],
  );

  const start = useCallback(
    async (name: string) => {
      setError(null);
      chunksRef.current = [];
      samplesRef.current = 0;
      setProgress(0);
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        setError('Microphone permission was not granted');
        setState('error');
        return;
      }
      try {
        recordingRef.current = true;
        await stream.start();
        setState('recording');
        const startedAt = Date.now();
        timerRef.current = setInterval(() => {
          const elapsed = Date.now() - startedAt;
          setProgress(Math.min(1, elapsed / ENROLL_DURATION_MS));
          if (elapsed >= ENROLL_DURATION_MS) void finish(name);
        }, 100);
      } catch (err) {
        recordingRef.current = false;
        setError(err instanceof Error ? err.message : String(err));
        setState('error');
      }
    },
    [stream, finish],
  );

  const reset = useCallback(() => {
    recordingRef.current = false;
    stopTimer();
    try {
      stream.stop();
    } catch {
      // already stopped
    }
    chunksRef.current = [];
    samplesRef.current = 0;
    setProgress(0);
    setError(null);
    setState('idle');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream]);

  useEffect(
    () => () => {
      recordingRef.current = false;
      stopTimer();
      try {
        stream.stop();
      } catch {
        // already stopped
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stream],
  );

  return { state, progress, error, start, reset };
}
