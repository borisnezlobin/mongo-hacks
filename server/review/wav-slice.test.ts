import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildWavHeader, parseWavLayout, readWavLayout, sliceWav } from './wav-slice';

const SAMPLE_RATE = 16_000;
const dir = mkdtempSync(join(tmpdir(), 'amelia-wav-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** One second per "tone", each a distinct constant so a slice is identifiable. */
function writeFixture(name: string, seconds: number): string {
  const layout = {
    dataOffset: 44,
    dataLength: seconds * SAMPLE_RATE * 2,
    sampleRate: SAMPLE_RATE,
    channels: 1,
    bitsPerSample: 16,
    bytesPerFrame: 2,
    durationMs: seconds * 1000,
  };
  const body = Buffer.alloc(layout.dataLength);
  for (let second = 0; second < seconds; second += 1) {
    for (let i = 0; i < SAMPLE_RATE; i += 1) {
      body.writeInt16LE(second + 1, (second * SAMPLE_RATE + i) * 2);
    }
  }
  const path = join(dir, name);
  writeFileSync(path, Buffer.concat([buildWavHeader(layout, layout.dataLength), body]));
  return path;
}

describe('wav slicing', () => {
  const path = writeFixture('five.wav', 5);

  it('reads the layout of a wav it wrote itself', async () => {
    const layout = await readWavLayout(path);
    expect(layout).toMatchObject({ sampleRate: SAMPLE_RATE, channels: 1, bitsPerSample: 16, durationMs: 5_000 });
  });

  it('returns exactly the requested span, and returns it as a playable wav', async () => {
    const slice = await sliceWav(path, 2_000, 3_000);
    const layout = parseWavLayout(slice.wav);
    expect(layout.durationMs).toBe(1_000);
    expect(slice.startMs).toBe(2_000);
    // Second three of the fixture is filled with the constant 3.
    expect(slice.wav.readInt16LE(44)).toBe(3);
    expect(slice.wav.readInt16LE(slice.wav.length - 2)).toBe(3);
  });

  it('clamps a span that runs off the end rather than reading past the data chunk', async () => {
    const slice = await sliceWav(path, 4_500, 9_000);
    expect(slice.endMs).toBe(5_000);
    expect(parseWavLayout(slice.wav).durationMs).toBe(500);
  });

  it('clamps a negative start to the beginning, which is what asking for context at 0s does', async () => {
    const slice = await sliceWav(path, -3_000, 1_000);
    expect(slice.startMs).toBe(0);
    expect(slice.wav.readInt16LE(44)).toBe(1);
  });

  it('believes the file over a header that lies about its data length', async () => {
    // Streaming encoders write 0 when the length is not yet known. Trusting it
    // would make every span of a still-recording conversation come back empty.
    const lying = join(dir, 'lying.wav');
    const source = writeFixture('source.wav', 2);
    const bytes = Buffer.from(readFileSync(source));
    bytes.writeUInt32LE(0, 40);
    writeFileSync(lying, bytes);
    const layout = await readWavLayout(lying);
    expect(layout.durationMs).toBe(2_000);
  });
});
