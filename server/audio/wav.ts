/** Minimal WAV reader for the fixture: 16-bit little-endian mono PCM. */

export interface WavAudio {
  sampleRate: number
  samples: Float32Array
}

export function readWav(bytes: Buffer): WavAudio {
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file')
  }
  let offset = 12
  let sampleRate = 0
  let bitsPerSample = 0
  let channels = 0
  let data: Buffer | null = null
  while (offset + 8 <= bytes.length) {
    const chunkId = bytes.toString('ascii', offset, offset + 4)
    const chunkSize = bytes.readUInt32LE(offset + 4)
    if (chunkId === 'fmt ') {
      channels = bytes.readUInt16LE(offset + 10)
      sampleRate = bytes.readUInt32LE(offset + 12)
      bitsPerSample = bytes.readUInt16LE(offset + 22)
    } else if (chunkId === 'data') {
      data = bytes.subarray(offset + 8, offset + 8 + chunkSize)
    }
    offset += 8 + chunkSize + (chunkSize % 2)
  }
  if (!data) throw new Error('no data chunk')
  if (channels !== 1 || bitsPerSample !== 16) {
    throw new Error(`expected 16-bit mono, got ${bitsPerSample}-bit ${channels}ch`)
  }
  const samples = new Float32Array(data.length / 2)
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = data.readInt16LE(i * 2) / 32768
  }
  return { sampleRate, samples }
}
