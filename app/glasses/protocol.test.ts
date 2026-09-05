import { describe, expect, it } from 'vitest';
import {
  AUDIO_FRAME_SAMPLES,
  GLASSES_FRAME_AUDIO,
  GLASSES_FRAME_JPEG,
  GLASSES_HEADER_BYTES,
} from '../../shared/contracts';
import {
  audioFrameToFloat32,
  encodeAudioFrame,
  encodeControl,
  encodeJpegFrame,
  parseGlassesFrame,
  parseGlassesMessage,
} from './protocol';

function tone(samples: number): Int16Array {
  const out = new Int16Array(samples);
  for (let index = 0; index < samples; index += 1) {
    out[index] = Math.round(Math.sin((index / 16) * Math.PI * 2) * 8_000);
  }
  return out;
}

describe('glasses protocol', () => {
  it('round-trips an audio frame', () => {
    const samples = tone(AUDIO_FRAME_SAMPLES);
    const frame = parseGlassesFrame(encodeAudioFrame(7, 1_234, samples));
    expect(frame?.kind).toBe(GLASSES_FRAME_AUDIO);
    if (frame?.kind !== GLASSES_FRAME_AUDIO) return;
    expect(frame.seq).toBe(7);
    expect(frame.ts_ms).toBe(1_234);
    expect(frame.samples.length).toBe(AUDIO_FRAME_SAMPLES);
    expect([...frame.samples]).toEqual([...samples]);
  });

  it('round-trips a jpeg frame with its size', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const frame = parseGlassesFrame(encodeJpegFrame(3, 99, 640, 480, jpeg));
    expect(frame?.kind).toBe(GLASSES_FRAME_JPEG);
    if (frame?.kind !== GLASSES_FRAME_JPEG) return;
    expect(frame.width).toBe(640);
    expect(frame.height).toBe(480);
    expect([...frame.jpeg]).toEqual([...jpeg]);
  });

  /** A frame handed over as a view into a larger socket buffer must parse the same. */
  it('parses a frame that sits at an offset inside a larger buffer', () => {
    const encoded = new Uint8Array(encodeAudioFrame(1, 5, tone(16)));
    const padded = new Uint8Array(encoded.length + 3);
    padded.set(encoded, 3);
    const frame = parseGlassesFrame(padded.subarray(3));
    expect(frame?.kind).toBe(GLASSES_FRAME_AUDIO);
  });

  it('converts audio samples to the float32 the stream contract wants', () => {
    const frame = parseGlassesFrame(encodeAudioFrame(0, 0, new Int16Array([0, 16_384, -32_768])));
    if (frame?.kind !== GLASSES_FRAME_AUDIO) throw new Error('expected audio');
    const floats = audioFrameToFloat32(frame);
    expect(floats[0]).toBe(0);
    expect(floats[1]).toBeCloseTo(0.5, 5);
    expect(floats[2]).toBe(-1);
  });

  it('returns null for a truncated or unknown frame', () => {
    expect(parseGlassesFrame(new ArrayBuffer(GLASSES_HEADER_BYTES - 1))).toBeNull();
    const unknown = new Uint8Array(GLASSES_HEADER_BYTES);
    unknown[0] = 0x7f;
    expect(parseGlassesFrame(unknown)).toBeNull();
    const shortJpeg = new Uint8Array(GLASSES_HEADER_BYTES + 1);
    shortJpeg[0] = GLASSES_FRAME_JPEG;
    expect(parseGlassesFrame(shortJpeg)).toBeNull();
  });

  it('parses hello and status text frames and ignores anything else', () => {
    const hello = parseGlassesMessage(
      JSON.stringify({ type: 'hello', protocol: 1, firmware: 'x', sample_rate: 16_000, frame_samples: 1_600 }),
    );
    expect(hello?.type).toBe('hello');
    expect(parseGlassesMessage('{"type":"status","ts_ms":1,"die_c":41,"camera":"idle","vad":false,"fps":0,"audio_drops":0,"frame_drops":0,"heap_free":1,"psram_free":1}')?.type)
      .toBe('status');
    expect(parseGlassesMessage('not json')).toBeNull();
    expect(parseGlassesMessage('{"type":"whatever"}')).toBeNull();
    expect(parseGlassesMessage('null')).toBeNull();
  });

  it('encodes control messages as the board expects', () => {
    expect(encodeControl({ type: 'burst', duration_ms: 5_000 })).toBe('{"type":"burst","duration_ms":5000}');
    expect(encodeControl({ type: 'ping' })).toBe('{"type":"ping"}');
  });
});
