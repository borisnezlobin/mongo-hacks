import { SAMPLE_RATE, type Word } from './types'

/** Shared PCM helpers for the batch providers (OpenRouter, pyannote). */

export function rms(samples: Float32Array): number {
  let energy = 0
  for (const sample of samples) energy += sample * sample
  return Math.sqrt(energy / samples.length)
}

export function concatenate(chunks: Float32Array[]): Float32Array {
  const output = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.length
  }
  return output
}

export function encodeWav(input: Float32Array): string {
  const dataBytes = input.length * 2
  const wav = Buffer.allocUnsafe(44 + dataBytes)
  wav.write('RIFF', 0, 'ascii')
  wav.writeUInt32LE(36 + dataBytes, 4)
  wav.write('WAVE', 8, 'ascii')
  wav.write('fmt ', 12, 'ascii')
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(SAMPLE_RATE, 24)
  wav.writeUInt32LE(SAMPLE_RATE * 2, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36, 'ascii')
  wav.writeUInt32LE(dataBytes, 40)
  for (let index = 0; index < input.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, input[index]))
    wav.writeInt16LE(sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767), 44 + index * 2)
  }
  return wav.toString('base64')
}

export function spreadWords(text: string, startMs: number, endMs: number): Word[] {
  // OpenRouter returns text without timestamps, so character-proportional
  // spans provide deterministic word midpoints for the downstream join.
  const words = text.trim().split(/\s+/).filter(Boolean)
  const total = words.reduce((sum, word) => sum + word.length, 0)
  let cursor = startMs
  return words.map((word) => {
    const width = total === 0 ? 0 : ((endMs - startMs) * word.length) / total
    const timed = { text: word, start_ms: Math.round(cursor), end_ms: Math.round(cursor + width) }
    cursor += width
    return timed
  })
}
