/**
 * Probe the live realtime provider against the REAL dorm recording.
 *
 * The existing probe uses the synthetic TTS fixture, which is far easier than
 * a phone on a desk in a room with three people talking over each other. This
 * one answers the question that actually matters: does live transcription hold
 * up on the audio this product will really see.
 *
 * Run with: npx tsx tools/probe-real.ts
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OpenAIRealtimeProvider } from '../server/audio/openai-realtime-provider'
import { readWav } from '../server/audio/wav'
import type { Segment, Word } from '../server/audio/types'

const here = dirname(fileURLToPath(import.meta.url))

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set')

  const path = process.env.PROBE_WAV ?? '../fixtures/real/dorm-9pm.wav'
  const wav = readWav(await readFile(join(here, path)))
  console.log(`fixture: ${path} ${(wav.samples.length / wav.sampleRate).toFixed(1)}s at ${wav.sampleRate} Hz`)
  console.log(`model:   ${process.env.OPENAI_TRANSCRIBE_MODEL ?? '(provider default)'}`)

  const provider = new OpenAIRealtimeProvider({ apiKey })
  const segments: Segment[] = []
  const words: Word[] = []
  const startedAt = Date.now()
  let firstWordMs: number | null = null

  provider.onSegments((incoming) => segments.push(...incoming))
  provider.onWords((incoming) => {
    if (firstWordMs === null && incoming.length > 0) firstWordMs = Date.now() - startedAt
    words.push(...incoming)
  })

  const FRAME = 1600
  for (let offset = 0; offset < wav.samples.length; offset += FRAME) {
    provider.pushAudio(wav.samples.subarray(offset, offset + FRAME), (offset / 16) | 0)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  try {
    await provider.close()
  } catch (error) {
    console.error(`provider closed with error: ${(error as Error).message}`)
  }

  console.log(`\nsegments ${segments.length}, words ${words.length}`)
  console.log(`speakers ${[...new Set(segments.map((s) => s.speaker))].join(', ') || '(none)'}`)
  console.log(`first word after ${firstWordMs ?? -1}ms of a ${(1790 * 20) / 1000}s paced push`)
  console.log('\ntranscript:')
  for (const segment of segments) {
    const text = words
      .filter((w) => w.start_ms >= segment.start_ms && w.end_ms <= segment.end_ms)
      .map((w) => w.text)
      .join(' ')
    console.log(`  ${segment.speaker} [${(segment.start_ms / 1000).toFixed(1)}s] ${text}`)
  }
}

void main()
