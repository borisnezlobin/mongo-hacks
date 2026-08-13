import { AUDIO_FRAME_SAMPLES } from '../../shared/contracts'

export function buildStreamUrl(base = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000'): string {
  const wsBase = base.replace(/^http/, 'ws').replace(/\/$/, '')
  return `${wsBase}/stream`
}

/** Copies a frame into an exactly-sized standalone buffer for WebSocket.send. */
export function frameToArrayBuffer(frame: Float32Array): ArrayBuffer {
  return frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) as ArrayBuffer
}

export class AudioFramePacketizer {
  private pending = new Float32Array(0)

  push(samples: Float32Array): ArrayBuffer[] {
    const joined = new Float32Array(this.pending.length + samples.length)
    joined.set(this.pending)
    joined.set(samples, this.pending.length)
    const frames: ArrayBuffer[] = []
    let offset = 0
    while (joined.length - offset >= AUDIO_FRAME_SAMPLES) {
      frames.push(frameToArrayBuffer(joined.subarray(offset, offset + AUDIO_FRAME_SAMPLES)))
      offset += AUDIO_FRAME_SAMPLES
    }
    this.pending = joined.slice(offset)
    return frames
  }

  reset(): void {
    this.pending = new Float32Array(0)
  }

  get pendingSamples(): number {
    return this.pending.length
  }
}
