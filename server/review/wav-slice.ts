/**
 * Cut a span out of a PCM wav by byte offset, without decoding it.
 *
 * The review page lives or dies on how fast a line starts playing. Decoding a
 * 92 MB wav to Float32 costs about a second and 370 MB of heap; seeking into it
 * with a Range request makes the browser wait on the container. Neither is
 * acceptable when the owner is going to click the same three seconds four times.
 *
 * 16-bit PCM is a flat array of samples, so the bytes for a span are computable
 * from the header alone. A four-second slice at 16 kHz mono is 128 KB, which
 * reads off local disk and decodes in the browser faster than a click registers.
 * The header is parsed once per file and cached against its size and mtime.
 */
import { open, stat } from 'node:fs/promises';

export interface WavLayout {
  dataOffset: number;
  dataLength: number;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  bytesPerFrame: number;
  durationMs: number;
}

export interface WavSlice {
  wav: Buffer;
  /** Where the returned audio actually starts, after clamping to the file. */
  startMs: number;
  endMs: number;
}

const HEADER_PROBE_BYTES = 64 * 1024;
const WAV_HEADER_BYTES = 44;

interface CacheEntry {
  layout: WavLayout;
  size: number;
  mtimeMs: number;
}

const layoutCache = new Map<string, CacheEntry>();

export function parseWavLayout(header: Buffer): WavLayout {
  if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let dataOffset = 0;
  let dataLength = 0;

  while (offset + 8 <= header.length) {
    const chunkId = header.toString('ascii', offset, offset + 4);
    const chunkSize = header.readUInt32LE(offset + 4);
    if (chunkId === 'fmt ') {
      channels = header.readUInt16LE(offset + 10);
      sampleRate = header.readUInt32LE(offset + 12);
      bitsPerSample = header.readUInt16LE(offset + 22);
    } else if (chunkId === 'data') {
      dataOffset = offset + 8;
      dataLength = chunkSize;
      break;
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }

  if (!dataOffset) throw new Error('no data chunk in the first 64 KB');
  if (bitsPerSample !== 16) throw new Error(`expected 16-bit PCM, got ${bitsPerSample}-bit`);
  if (channels < 1) throw new Error('no channels declared');

  const bytesPerFrame = (bitsPerSample / 8) * channels;
  return {
    dataOffset,
    dataLength,
    sampleRate,
    channels,
    bitsPerSample,
    bytesPerFrame,
    durationMs: Math.floor((dataLength / bytesPerFrame / sampleRate) * 1000),
  };
}

export async function readWavLayout(path: string): Promise<WavLayout> {
  const info = await stat(path);
  const cached = layoutCache.get(path);
  if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return cached.layout;

  const handle = await open(path, 'r');
  try {
    const probe = Buffer.alloc(Math.min(HEADER_PROBE_BYTES, info.size));
    await handle.read(probe, 0, probe.length, 0);
    const layout = parseWavLayout(probe);
    // A wav written by a streaming encoder can declare a data size of 0 or
    // 0xFFFFFFFF because the length was unknown when the header went down.
    // The file on disk knows better.
    const onDisk = info.size - layout.dataOffset;
    if (layout.dataLength === 0 || layout.dataLength > onDisk) {
      layout.dataLength = onDisk;
      layout.durationMs = Math.floor((onDisk / layout.bytesPerFrame / layout.sampleRate) * 1000);
    }
    layoutCache.set(path, { layout, size: info.size, mtimeMs: info.mtimeMs });
    return layout;
  } finally {
    await handle.close();
  }
}

export function buildWavHeader(layout: WavLayout, dataLength: number): Buffer {
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  const byteRate = layout.sampleRate * layout.bytesPerFrame;
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(layout.channels, 22);
  header.writeUInt32LE(layout.sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(layout.bytesPerFrame, 32);
  header.writeUInt16LE(layout.bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataLength, 40);
  return header;
}

function alignDown(byte: number, frame: number): number {
  return byte - (byte % frame);
}

export async function sliceWav(path: string, requestedStartMs: number, requestedEndMs: number): Promise<WavSlice> {
  const layout = await readWavLayout(path);
  const startMs = Math.max(0, Math.min(requestedStartMs, layout.durationMs));
  const endMs = Math.max(startMs, Math.min(requestedEndMs, layout.durationMs));

  const bytesPerMs = (layout.sampleRate * layout.bytesPerFrame) / 1000;
  const rawStart = alignDown(Math.floor(startMs * bytesPerMs), layout.bytesPerFrame);
  const rawEnd = alignDown(Math.ceil(endMs * bytesPerMs), layout.bytesPerFrame);
  const length = Math.max(0, Math.min(rawEnd, layout.dataLength) - rawStart);

  const body = Buffer.alloc(length);
  if (length > 0) {
    const handle = await open(path, 'r');
    try {
      await handle.read(body, 0, length, layout.dataOffset + rawStart);
    } finally {
      await handle.close();
    }
  }

  return {
    wav: Buffer.concat([buildWavHeader(layout, length), body]),
    startMs: Math.round(rawStart / bytesPerMs),
    endMs: Math.round((rawStart + length) / bytesPerMs),
  };
}
