import { describe, expect, it } from 'vitest';
import { AUDIO_FRAME_BYTES, AUDIO_FRAME_SAMPLES } from '../../shared/contracts';
import { frameChunks, resample } from './uplink';

/** Integer values: exactly representable in float32, so equality is safe. */
const ramp = (n: number, from = 0) => Float32Array.from({ length: n }, (_, i) => from + i);
const EMPTY: Float32Array<ArrayBufferLike> = new Float32Array(0);

describe('frameChunks', () => {
  it('emits nothing until a whole frame is available', () => {
    const { frames, rest } = frameChunks(EMPTY, ramp(AUDIO_FRAME_SAMPLES - 1));
    expect(frames).toHaveLength(0);
    expect(rest).toHaveLength(AUDIO_FRAME_SAMPLES - 1);
  });

  it('emits exactly one frame of exactly the contract size', () => {
    const { frames, rest } = frameChunks(EMPTY, ramp(AUDIO_FRAME_SAMPLES));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toHaveLength(AUDIO_FRAME_SAMPLES);
    expect(frames[0]!.byteLength).toBe(AUDIO_FRAME_BYTES);
    expect(rest).toHaveLength(0);
  });

  it('carries the remainder across calls and loses no samples', () => {
    // Glasses chunk sizes are arbitrary and will not divide the frame size.
    const sizes = [700, 700, 700, 250, 1, 4321];
    let carry: Float32Array<ArrayBufferLike> = EMPTY;
    let emitted = 0;
    const seen: number[] = [];
    let produced = 0;

    for (const size of sizes) {
      const chunk = ramp(size, produced);
      produced += size;
      const result = frameChunks(carry, chunk);
      carry = result.rest;
      for (const frame of result.frames) {
        expect(frame).toHaveLength(AUDIO_FRAME_SAMPLES);
        seen.push(...frame);
        emitted += frame.length;
      }
    }

    expect(emitted + carry.length).toBe(produced);
    // Order preserved and nothing duplicated: the concatenated frames are
    // exactly the original ramp prefix.
    expect(seen).toEqual(Array.from({ length: seen.length }, (_, i) => i));
  });

  it('splits a large chunk into several whole frames', () => {
    const { frames, rest } = frameChunks(EMPTY, ramp(AUDIO_FRAME_SAMPLES * 3 + 5));
    expect(frames).toHaveLength(3);
    expect(rest).toHaveLength(5);
  });

  it('returns frames backed by their own buffers', () => {
    // A subarray would alias the merged buffer, which is dropped on the next
    // call — ws may serialize after this tick, so the bytes must be owned.
    const { frames } = frameChunks(EMPTY, ramp(AUDIO_FRAME_SAMPLES * 2));
    expect(frames[0]!.buffer).not.toBe(frames[1]!.buffer);
    expect(frames[0]!.byteOffset).toBe(0);
  });
});

describe('resample', () => {
  it('passes through when the rate already matches', () => {
    const input = ramp(100);
    expect(resample(input, 16_000, 16_000)).toBe(input);
  });

  it('halves the sample count going 32 kHz to 16 kHz', () => {
    expect(resample(ramp(1_000), 32_000, 16_000)).toHaveLength(500);
  });

  it('upsamples 8 kHz to 16 kHz', () => {
    expect(resample(ramp(500), 8_000, 16_000)).toHaveLength(1_000);
  });

  it('tolerates an empty chunk', () => {
    expect(resample(EMPTY, 44_100, 16_000)).toHaveLength(0);
  });
});
