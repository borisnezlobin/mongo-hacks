import { describe, expect, it } from 'vitest';
import { int16ToFloat32, resampleTo16k } from './resample';

describe('resampleTo16k', () => {
  it('returns the input unchanged when already at 16 kHz', () => {
    const input = new Float32Array([0, 0.25, -0.5, 0.75, -1]);
    const output = resampleTo16k(input, 16_000);

    expect(output).toBe(input);
    expect(Array.from(output)).toEqual(Array.from(input));
  });

  it('downsamples a 48 kHz sine wave and preserves the sample-count ratio', () => {
    const inputRate = 48_000;
    const durationSeconds = 0.1;
    const frequencyHz = 440;
    const inputLength = Math.round(inputRate * durationSeconds);
    const input = new Float32Array(inputLength);
    for (let i = 0; i < inputLength; i++) {
      input[i] = Math.sin((2 * Math.PI * frequencyHz * i) / inputRate);
    }

    const output = resampleTo16k(input, inputRate);
    const expectedRatio = 16_000 / inputRate;
    const expectedLength = Math.round(inputLength * expectedRatio);

    expect(output.length).toBe(expectedLength);
    expect(output.length).toBeLessThan(input.length);

    // Every value should still be a valid PCM sample, and the resampled signal
    // should retain roughly the same energy as the original (no collapse to silence).
    for (const sample of output) {
      expect(sample).toBeGreaterThanOrEqual(-1);
      expect(sample).toBeLessThanOrEqual(1);
    }
    const inputRms = Math.sqrt(input.reduce((sum, v) => sum + v * v, 0) / input.length);
    const outputRms = Math.sqrt(output.reduce((sum, v) => sum + v * v, 0) / output.length);
    expect(outputRms).toBeGreaterThan(inputRms * 0.9);
  });

  it('upsamples a lower sample rate and preserves the sample-count ratio', () => {
    const input = new Float32Array(80).fill(0).map((_, i) => Math.sin(i / 5));
    const output = resampleTo16k(input, 8_000);

    expect(output.length).toBe(Math.round(input.length * (16_000 / 8_000)));
  });

  it('handles empty input without dividing by zero', () => {
    const output = resampleTo16k(new Float32Array(0), 48_000);
    expect(output.length).toBe(0);
  });
});

describe('int16ToFloat32', () => {
  it('converts the full int16 range into [-1, 1] float32 samples', () => {
    const input = new Int16Array([0, 32_767, -32_768, 16_384, -16_384]);
    const output = int16ToFloat32(input);

    expect(output[0]).toBeCloseTo(0, 5);
    expect(output[1]).toBeCloseTo(0.999969, 5);
    expect(output[2]).toBeCloseTo(-1, 5);
    expect(output[3]).toBeCloseTo(0.5, 5);
    expect(output[4]).toBeCloseTo(-0.5, 5);
  });

  it('preserves sample count', () => {
    const input = new Int16Array(1_600).fill(100);
    const output = int16ToFloat32(input);
    expect(output.length).toBe(input.length);
  });
});
