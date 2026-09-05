import { describe, expect, it } from 'vitest';
import { AUDIO_FRAME_SAMPLES, GLASSES_FRAME_AUDIO, GLASSES_FRAME_JPEG, PREROLL_MS } from '../../shared/contracts';
import type { GlassesAudioFrame, GlassesJpegFrame } from '../../shared/contracts';
import { AUDIO_FRAME_MS, PrerollBuffer, alignToAudioClock, streamMsFor } from './preroll';

const audio = (seq: number, tsMs: number): GlassesAudioFrame => ({
  kind: GLASSES_FRAME_AUDIO,
  seq,
  ts_ms: tsMs,
  samples: new Int16Array(AUDIO_FRAME_SAMPLES),
});

const jpeg = (seq: number, tsMs: number): GlassesJpegFrame => ({
  kind: GLASSES_FRAME_JPEG,
  seq,
  ts_ms: tsMs,
  width: 640,
  height: 480,
  jpeg: new Uint8Array([1]),
});

function fill(buffer: PrerollBuffer, frames: number, startMs = 0): void {
  for (let index = 0; index < frames; index += 1) {
    buffer.pushAudio(audio(index, startMs + index * AUDIO_FRAME_MS));
  }
}

describe('preroll buffer', () => {
  it('keeps audio in order and reports how full it is', () => {
    const buffer = new PrerollBuffer();
    fill(buffer, 10);
    expect(buffer.audioFrames).toBe(10);
    expect(buffer.fillMs).toBe(10 * AUDIO_FRAME_MS);
    expect(buffer.drain().audio.map((frame) => frame.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('drops everything older than the window', () => {
    const buffer = new PrerollBuffer();
    fill(buffer, Math.floor(PREROLL_MS / AUDIO_FRAME_MS) + 40);
    expect(buffer.fillMs).toBeLessThanOrEqual(PREROLL_MS + AUDIO_FRAME_MS);
  });

  it('prunes frames as well as audio', () => {
    const buffer = new PrerollBuffer(1_000);
    buffer.pushFrame(jpeg(1, 0), []);
    buffer.pushFrame(jpeg(2, 900), []);
    buffer.pushAudio(audio(0, 1_800));
    expect(buffer.videoFrames).toBe(1);
  });

  /** Draining is a transfer. A second drain must not replay the conversation's opener. */
  it('is empty after a drain', () => {
    const buffer = new PrerollBuffer();
    fill(buffer, 5);
    buffer.pushFrame(jpeg(1, 120), []);
    expect(buffer.drain().audio).toHaveLength(5);
    const second = buffer.drain();
    expect(second.audio).toHaveLength(0);
    expect(second.frames).toHaveLength(0);
    expect(buffer.fillMs).toBe(0);
  });

  it('hands back the newest speech for the owner check', () => {
    const buffer = new PrerollBuffer();
    fill(buffer, 100);
    const newest = buffer.newestAudio(3_000);
    expect(newest).toHaveLength(30);
    expect(newest[newest.length - 1].seq).toBe(99);
  });

  it('reports the first audio timestamp as the conversation origin', () => {
    const buffer = new PrerollBuffer();
    fill(buffer, 4, 5_000);
    expect(buffer.drain().firstAudioTsMs).toBe(5_000);
  });
});

describe('stream clock', () => {
  it('offsets a board timestamp against the first frame', () => {
    expect(streamMsFor(5_400, 5_000)).toBe(400);
    expect(streamMsFor(4_000, 5_000)).toBe(0);
  });

  /**
   * The board's wall clock and the stream clock diverge the moment a frame is
   * dropped, so an observation is placed by which audio frame it landed near.
   */
  it('snaps a frame timestamp to the audio frame index, not the wall clock', () => {
    const kept = [audio(0, 0), audio(1, 100), audio(2, 200), audio(5, 500), audio(6, 600)];
    expect(alignToAudioClock(0, kept)).toBe(0);
    expect(alignToAudioClock(210, kept)).toBe(200);
    // Two frames were dropped, so 500 ms of board time is 300 ms of stream time.
    expect(alignToAudioClock(510, kept)).toBe(300);
    expect(alignToAudioClock(1_000, kept)).toBe(400);
  });

  it('is zero with no audio to align against', () => {
    expect(alignToAudioClock(1_234, [])).toBe(0);
  });
});
