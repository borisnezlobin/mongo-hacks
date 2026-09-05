/**
 * The fifteen seconds before anybody decided to record.
 *
 * A conversation is recognised from its first few words, which means those
 * words are already past by the time recording starts. The ring keeps them in
 * memory — never on disk — and flushes them into the new conversation so the
 * other person's opener survives. While idle it is the only place audio goes.
 */

import {
  AUDIO_FRAME_SAMPLES,
  PREROLL_MS,
  type GlassesAudioFrame,
  type Id,
  type GlassesJpegFrame,
} from '../../shared/contracts';
import type { FaceTrack } from './face-tracker';

/** One frame of audio is one frame of the stream clock: 1,600 samples at 16 kHz. */
export const AUDIO_FRAME_MS = AUDIO_FRAME_SAMPLES / 16;

export interface PrerollFrame {
  frame: GlassesJpegFrame;
  tracks: FaceTrack[];
  /** Who was talking in this frame, kept so the replay carries the same claim. */
  active_track_id?: Id;
}

export interface PrerollContents {
  audio: GlassesAudioFrame[];
  frames: PrerollFrame[];
  /** Board timestamp of the first audio frame, which becomes stream_ms zero. */
  firstAudioTsMs: number;
}

/** Position in the new conversation's audio clock, from the board's clock. */
export function streamMsFor(tsMs: number, firstTsMs: number): number {
  return Math.max(0, tsMs - firstTsMs);
}

/**
 * The stream clock counts frames, not milliseconds.
 *
 * The server derives every timestamp from a monotonic sample cursor, so once
 * the board has dropped an audio frame its wall clock and the stream clock
 * have diverged permanently. A face observation carrying wall-clock time would
 * line up against the wrong turn. Snapping to the nearest audio frame's index
 * puts the observation back on the clock the transcript is actually on.
 */
export function alignToAudioClock(tsMs: number, audio: readonly { ts_ms: number }[]): number {
  if (audio.length === 0) return 0;
  let nearest = 0;
  let best = Infinity;
  for (let index = 0; index < audio.length; index += 1) {
    const distance = Math.abs(audio[index].ts_ms - tsMs);
    if (distance >= best) continue;
    best = distance;
    nearest = index;
  }
  return nearest * AUDIO_FRAME_MS;
}

export class PrerollBuffer {
  private audio: GlassesAudioFrame[] = [];
  private frames: PrerollFrame[] = [];

  constructor(private readonly windowMs: number = PREROLL_MS) {}

  get audioFrames(): number {
    return this.audio.length;
  }

  get videoFrames(): number {
    return this.frames.length;
  }

  /** How much of the ring is full, which the dev sheet shows and the arming check reads. */
  get fillMs(): number {
    if (this.audio.length === 0) return 0;
    return this.audio[this.audio.length - 1].ts_ms - this.audio[0].ts_ms + AUDIO_FRAME_MS;
  }

  pushAudio(frame: GlassesAudioFrame): void {
    this.audio.push(frame);
    this.prune(frame.ts_ms);
  }

  pushFrame(frame: GlassesJpegFrame, tracks: FaceTrack[], activeTrackId?: Id): void {
    this.frames.push({ frame, tracks, active_track_id: activeTrackId });
    this.prune(frame.ts_ms);
  }

  prune(nowMs: number): void {
    const cutoff = nowMs - this.windowMs;
    this.audio = this.audio.filter((frame) => frame.ts_ms >= cutoff);
    this.frames = this.frames.filter((entry) => entry.frame.ts_ms >= cutoff);
  }

  /** The newest span of audio, for the owner check that decides whether to record. */
  newestAudio(durationMs: number): GlassesAudioFrame[] {
    if (this.audio.length === 0) return [];
    const cutoff = this.audio[this.audio.length - 1].ts_ms - durationMs + AUDIO_FRAME_MS;
    return this.audio.filter((frame) => frame.ts_ms >= cutoff);
  }

  /**
   * Hands everything over and empties. Draining is a transfer, not a read: the
   * frames are now the conversation's, and a second drain must not replay them.
   */
  drain(): PrerollContents {
    const contents: PrerollContents = {
      audio: this.audio,
      frames: this.frames,
      firstAudioTsMs: this.audio[0]?.ts_ms ?? this.frames[0]?.frame.ts_ms ?? 0,
    };
    this.audio = [];
    this.frames = [];
    return contents;
  }

  clear(): void {
    this.audio = [];
    this.frames = [];
  }
}
