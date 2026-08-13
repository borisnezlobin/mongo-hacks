import { describe, expect, it } from 'vitest'
import { AUDIO_FRAME_BYTES, AUDIO_FRAME_SAMPLES } from '../../shared/contracts'
import { AudioFramePacketizer, buildStreamUrl } from './uplink-buffer'

describe('audio uplink framing', () => {
  it('builds ws and wss stream URLs without duplicate slashes', () => {
    expect(buildStreamUrl('http://localhost:3000/')).toBe('ws://localhost:3000/stream')
    expect(buildStreamUrl('https://amelia.example')).toBe('wss://amelia.example/stream')
  })

  it('emits exact 6400-byte frames and retains the remainder', () => {
    const packetizer = new AudioFramePacketizer()
    expect(packetizer.push(new Float32Array(1000))).toEqual([])
    const frames = packetizer.push(new Float32Array(AUDIO_FRAME_SAMPLES * 2))
    expect(frames).toHaveLength(2)
    expect(frames[0].byteLength).toBe(AUDIO_FRAME_BYTES)
    expect(frames[1].byteLength).toBe(AUDIO_FRAME_BYTES)
    expect(packetizer.pendingSamples).toBe(1000)

    const final = packetizer.push(new Float32Array(600))
    expect(final).toHaveLength(1)
    expect(final[0].byteLength).toBe(AUDIO_FRAME_BYTES)
    expect(packetizer.pendingSamples).toBe(0)
  })

  it('resets buffered samples when a stream stops', () => {
    const packetizer = new AudioFramePacketizer()
    packetizer.push(new Float32Array(200))
    packetizer.reset()
    expect(packetizer.pendingSamples).toBe(0)
  })
})
