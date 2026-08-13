/**
 * Pure DSP helpers for turning whatever PCM the capture layer hands back into the
 * wire format Amelia's audio uplink expects: float32, 16 kHz, mono. No expo or
 * React Native imports live here so this file stays testable under plain node/vitest.
 */

/**
 * Resamples float32 PCM to 16 kHz using linear interpolation. Returns the input
 * unchanged (no copy) when it is already at 16 kHz, since that is the common case
 * once the native stream is opened with sampleRate: 16000.
 */
export function resampleTo16k(input: Float32Array, inputRate: number): Float32Array {
  if (inputRate === 16_000 || input.length === 0) {
    return input;
  }

  const ratio = inputRate / 16_000;
  const outputLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const sourceIndex = i * ratio;
    const indexLow = Math.floor(sourceIndex);
    const indexHigh = Math.min(indexLow + 1, input.length - 1);
    const frac = sourceIndex - indexLow;
    output[i] = input[indexLow] * (1 - frac) + input[indexHigh] * frac;
  }

  return output;
}

/** Converts little-endian int16 PCM samples to float32 samples in the range [-1, 1]. */
export function int16ToFloat32(input: Int16Array): Float32Array {
  const output = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) {
    output[i] = input[i] / 32_768;
  }
  return output;
}
