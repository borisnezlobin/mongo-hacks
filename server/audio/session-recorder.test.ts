import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readAudioConfig } from './config'
import { SessionRecorder } from './session-recorder'
import { readWav } from './wav'

const dirs: string[] = []

function recorder(overrides: Record<string, string> = {}): SessionRecorder {
  const dir = mkdtempSync(join(tmpdir(), 'amelia-retain-'))
  dirs.push(dir)
  return new SessionRecorder('c-1', readAudioConfig({ AUDIO_RETAIN_DIR: dir, ...overrides }))
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('SessionRecorder', () => {
  it('writes a readable 16 kHz mono WAV with the length patched in', async () => {
    const session = recorder()
    session.write(new Float32Array(16_000).fill(0.5))
    session.write(new Float32Array(8_000).fill(-0.25))
    const path = await session.close()

    expect(path).not.toBeNull()
    const wav = readWav(readFileSync(path as string))
    expect(wav.sampleRate).toBe(16_000)
    expect(wav.samples).toHaveLength(24_000)
    expect(wav.samples[0]).toBeCloseTo(0.5, 3)
    expect(wav.samples[20_000]).toBeCloseTo(-0.25, 3)
  })

  /** A laptop left recording must not be allowed to fill the disk. */
  it('stops at the retention cap and reports the file as truncated', async () => {
    const session = recorder({ AUDIO_RETAIN_MAX_MS: '1000' })
    session.write(new Float32Array(32_000).fill(0.1))
    const path = await session.close()

    expect(session.isTruncated).toBe(true)
    expect(session.durationMs).toBe(1_000)
    expect(readWav(readFileSync(path as string)).samples).toHaveLength(16_000)
  })

  it('produces nothing at all when no audio was ever written', async () => {
    await expect(recorder().close()).resolves.toBeNull()
  })
})
