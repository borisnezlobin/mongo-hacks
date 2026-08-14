/** Diarisation and transcription inputs, normalised to ms-from-stream-start. */

export const SAMPLE_RATE = 16_000

/** One speaker-homogeneous span from diarisation. */
export interface Segment {
  speaker: string // session-local label, e.g. 'SPEAKER_00'
  start_ms: number
  end_ms: number
}

/** One word from the transcription stream, with its own timing. */
export interface Word {
  text: string
  start_ms: number
  end_ms: number
  /**
   * The provider turn this word belongs to, when the provider knows it.
   *
   * Streaming transcription re-sends a turn's whole text as it grows, and the
   * timings are redistributed across the words every time — so the same word
   * lands on a different start_ms in each revision. Keying words by start_ms
   * alone therefore stacked every partial on top of the last instead of
   * replacing it. Words carrying a turn are replaced as a set.
   */
  turn?: string
}

/** A speaker-homogeneous run of words. What the rest of the system consumes. */
export interface PendingUtterance {
  session_speaker: string
  text: string
  start_ms: number
  end_ms: number
}

/**
 * A source of diarisation segments and transcribed words for one stream.
 * Real providers wrap pyannote and OpenAI Realtime; the fixture provider
 * replays transcript.json. The session pushes PCM in; the provider calls
 * back with whatever it has learned.
 */
export interface StreamProvider {
  /** Feed one chunk of float32 PCM at the stream position where it starts. */
  pushAudio(pcm: Float32Array, positionMs: number): void
  onSegments(handler: (segments: Segment[]) => void): void
  onWords(handler: (words: Word[]) => void): void
  close(): Promise<void>
}
