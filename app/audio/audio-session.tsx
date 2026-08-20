import { createContext, useCallback, useContext, useMemo, useRef, type ReactNode } from 'react';
import { requestRecordingPermissionsAsync, useAudioStream } from 'expo-audio';
import type { AudioStreamBuffer, AudioStreamEncoding, AudioStreamOptions } from 'expo-audio';
import { int16ToFloat32, resampleTo16k } from './resample';

/**
 * One microphone, one owner.
 *
 * Live capture and owner enrollment each used to open their own `useAudioStream`, and
 * the enrollment one was mounted for the app's entire lifetime with nothing arbitrating
 * between them — two native capture sessions competing for the same hardware. There is
 * a single stream here, and exactly one holder at a time.
 */

const STREAM_ENCODING: AudioStreamEncoding = 'float32';

export type AudioOwner = 'capture' | 'enrollment';

export class MicrophoneBusyError extends Error {
  constructor(readonly holder: AudioOwner) {
    super(holder === 'capture'
      ? 'Amelia is already listening. Stop the recording first.'
      : 'Voice setup is using the microphone. Finish it first.');
    this.name = 'MicrophoneBusyError';
  }
}

export interface AudioSession {
  /** Takes the microphone. Throws MicrophoneBusyError if someone else holds it. */
  acquire(owner: AudioOwner, onSamples: (samples: Float32Array) => void): Promise<void>;
  /** Gives it back. A release from a non-holder is ignored, so teardown races are safe. */
  release(owner: AudioOwner): void;
  holder(): AudioOwner | null;
}

const AudioSessionContext = createContext<AudioSession | null>(null);

export function AudioSessionProvider({ children }: { children: ReactNode }) {
  const holderRef = useRef<AudioOwner | null>(null);
  const sinkRef = useRef<((samples: Float32Array) => void) | null>(null);

  const handleBuffer = useCallback((buffer: AudioStreamBuffer) => {
    const sink = sinkRef.current;
    if (!sink) return;
    const raw = STREAM_ENCODING === 'int16'
      ? int16ToFloat32(new Int16Array(buffer.data))
      : new Float32Array(buffer.data);
    sink(resampleTo16k(raw, buffer.sampleRate));
  }, []);

  const streamOptions = useMemo<AudioStreamOptions>(
    () => ({ sampleRate: 16_000, channels: 1, encoding: STREAM_ENCODING, onBuffer: handleBuffer }),
    [handleBuffer],
  );
  const { stream } = useAudioStream(streamOptions);

  const session = useMemo<AudioSession>(() => ({
    async acquire(owner, onSamples) {
      if (holderRef.current && holderRef.current !== owner) throw new MicrophoneBusyError(holderRef.current);
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) throw new Error('Microphone permission was not granted');
      holderRef.current = owner;
      sinkRef.current = onSamples;
      try {
        await stream.start();
      } catch (error) {
        // A failed native start must not leave the session marked as held, or the
        // microphone is unreachable for the rest of the app's life.
        holderRef.current = null;
        sinkRef.current = null;
        throw error;
      }
    },
    release(owner) {
      if (holderRef.current !== owner) return;
      holderRef.current = null;
      sinkRef.current = null;
      try {
        stream.stop();
      } catch {
        // Native capture may already have stopped; releasing twice is not an error.
      }
    },
    holder: () => holderRef.current,
  }), [stream]);

  return <AudioSessionContext.Provider value={session}>{children}</AudioSessionContext.Provider>;
}

export function useAudioSession(): AudioSession {
  const session = useContext(AudioSessionContext);
  if (!session) throw new Error('useAudioSession must be used inside AudioSessionProvider');
  return session;
}
