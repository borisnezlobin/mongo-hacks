/**
 * Probe the live transcription provider against the real OpenAI Realtime API.
 *
 * Pushes the fixture WAV through OpenAIRealtimeProvider exactly as a live
 * session would and prints whatever segments and words come back. Uses real
 * recorded speech, so it verifies the key, the model access, the event shapes
 * and the diarisation labels without needing a microphone.
 *
 * Run with: npx tsx tools/probe-realtime.ts
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

  const wav = readWav(await readFile(join(here, '../fixtures/conversation.wav')))
  console.log(`fixture: ${(wav.samples.length / wav.sampleRate).toFixed(2)}s at ${wav.sampleRate} Hz`)

  const provider = new OpenAIRealtimeProvider({ apiKey })
  const segments: Segment[] = []
  const words: Word[] = []

  provider.onSegments((incoming) => {
    for (const segment of incoming) {
      segments.push(segment)
      console.log(`  segment speaker=${segment.speaker} ${segment.start_ms}-${segment.end_ms}ms`)
    }
  })
  provider.onWords((incoming) => words.push(...incoming))

  const FRAME = 1600
  for (let offset = 0; offset < wav.samples.length; offset += FRAME) {
    provider.pushAudio(wav.samples.subarray(offset, offset + FRAME), (offset / 16) | 0)
    // Pace roughly realtime so server-side turn detection behaves as it would live.
    await new Promise((resolve) => setTimeout(resolve, 20))
  }

  try {
    await provider.close()
  } catch (error) {
    console.error(`provider closed with error: ${(error as Error).message}`)
  }

  console.log(`\nsegments: ${segments.length}`)
  console.log(`words:    ${words.length}`)
  const speakers = [...new Set(segments.map((s) => s.speaker))]
  console.log(`speakers: ${speakers.join(', ') || '(none)'}`)
  console.log('\ntranscript by segment:')
  for (const segment of segments) {
    const text = words
      .filter((word) => word.start_ms >= segment.start_ms && word.end_ms <= segment.end_ms)
      .map((word) => word.text)
      .join(' ')
    console.log(`  [${segment.speaker}] ${text}`)
  }
}

main()
