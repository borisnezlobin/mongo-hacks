/**
 * Writes a session's PCM to a 16 kHz mono WAV as it streams.
 *
 * The final diarization pass needs the whole conversation as a file, and the
 * in-memory StreamBuffer is not it: a session that outlives the process, or one
 * long enough to matter, cannot be held in a Float32Array and re-uploaded from
 * RAM. Frames are appended as they arrive and the RIFF header is patched on
 * close, so a crashed session still leaves a playable file minus its header
 * length — recoverable, unlike nothing at all.
 *
 * Bounded on purpose. Past `retainMaxMs` the recorder stops writing and says
 * so, rather than filling the disk of whoever left a laptop recording.
 */

import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { audioConfig } from './config'
import { SAMPLE_RATE } from './types'

const HEADER_BYTES = 44

function riffHeader(dataBytes: number): Buffer {
  const header = Buffer.alloc(HEADER_BYTES)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(SAMPLE_RATE, 24)
  header.writeUInt32LE(SAMPLE_RATE * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(dataBytes, 40)
  return header
}

function toPcm16(input: Float32Array): Buffer {
  const out = Buffer.allocUnsafe(input.length * 2)
  for (let i = 0; i < input.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, input[i]))
    out.writeInt16LE(clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767), i * 2)
  }
  return out
}

export class SessionRecorder {
  readonly path: string
  private stream: WriteStream | null = null
  private samplesWritten = 0
  private readonly maxSamples: number
  private truncated = false
  private failure: Error | null = null

  constructor(conversationId: string, private readonly config = audioConfig()) {
    this.path = join(this.config.retainDir, `${sanitize(conversationId)}.wav`)
    this.maxSamples = Math.round((this.config.retainMaxMs / 1000) * SAMPLE_RATE)
  }

  get durationMs(): number {
    return Math.round((this.samplesWritten / SAMPLE_RATE) * 1000)
  }

  /** True once the cap was hit: the retained file is a prefix, not the session. */
  get isTruncated(): boolean {
    return this.truncated
  }

  get error(): Error | null {
    return this.failure
  }

  write(pcm: Float32Array): void {
    if (this.failure || this.samplesWritten >= this.maxSamples) return
    const room = this.maxSamples - this.samplesWritten
    const slice = pcm.length > room ? pcm.subarray(0, room) : pcm
    try {
      if (!this.stream) {
        mkdirSync(this.config.retainDir, { recursive: true })
        this.stream = createWriteStream(this.path)
        this.stream.on('error', (error) => {
          this.failure = error as Error
        })
        this.stream.write(riffHeader(0))
      }
      this.stream.write(toPcm16(slice))
      this.samplesWritten += slice.length
      if (this.samplesWritten >= this.maxSamples) {
        this.truncated = true
        console.warn(
          `session audio hit the ${this.config.retainMaxMs} ms retention cap; the final ` +
            'diarization pass will only cover what was kept',
        )
      }
    } catch (error) {
      this.failure = error as Error
      console.error(`session audio retention failed for ${this.path}`, error)
    }
  }

  /** Flush, patch the header with the real length, and hand back the path. */
  async close(): Promise<string | null> {
    const stream = this.stream
    this.stream = null
    if (!stream) return null
    await new Promise<void>((resolve) => stream.end(resolve))
    if (this.failure || this.samplesWritten === 0) return null
    const handle = await open(this.path, 'r+')
    try {
      await handle.write(riffHeader(this.samplesWritten * 2), 0, HEADER_BYTES, 0)
    } finally {
      await handle.close()
    }
    return this.path
  }
}

function sanitize(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_')
}
