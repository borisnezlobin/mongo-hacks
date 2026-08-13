/**
 * Dump raw OpenAI Realtime event types for a transcription model.
 *
 * The provider only understands the event shapes it was written against, so
 * when a model returns nothing this shows what it actually sends. Diagnostic
 * only; not part of the server.
 *
 * Run with: OPENAI_TRANSCRIBE_MODEL=gpt-transcribe npx tsx tools/probe-raw-events.ts
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { readWav } from '../server/audio/wav'

const here = dirname(fileURLToPath(import.meta.url))
const MODEL = process.env.OPENAI_TRANSCRIBE_MODEL ?? 'gpt-transcribe'
const TURN_DETECTION = process.env.NO_TURN_DETECTION !== '1'

function pcm16Base64(input: Float32Array): string {
  const bytes = Buffer.allocUnsafe(input.length * 2)
  for (let index = 0; index < input.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, input[index]))
    bytes.writeInt16LE(Math.round(sample * 32767), index * 2)
  }
  return bytes.toString('base64')
}

function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input.slice()
  const output = new Float32Array(Math.round((input.length * to) / from))
  const ratio = from / to
  for (let i = 0; i < output.length; i += 1) {
    const pos = i * ratio
    const left = Math.floor(pos)
    const right = Math.min(left + 1, input.length - 1)
    output[i] = input[left] * (1 - (pos - left)) + input[right] * (pos - left)
  }
  return output
}

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set')
  const wav = readWav(await readFile(join(here, '../fixtures/conversation.wav')))

  const socket = new WebSocket('wss://api.openai.com/v1/realtime?intent=transcription', {
    headers: { Authorization: `Bearer ${apiKey}` },
  })

  const counts = new Map<string, number>()
  const samples: string[] = []

  socket.on('open', () => {
    const input: Record<string, unknown> = {
      format: { type: 'audio/pcm', rate: 24_000 },
      transcription: { model: MODEL, language: 'en' },
    }
    if (TURN_DETECTION) {
      input.turn_detection = {
        type: 'server_vad',
        threshold: 0.5,
        silence_duration_ms: Number(process.env.SILENCE_MS ?? 500),
      }
    }
    socket.send(JSON.stringify({ type: 'session.update', session: { type: 'transcription', audio: { input } } }))

    const pcm = resample(wav.samples, wav.sampleRate, 24_000)
    const CHUNK = 2400
    let offset = 0
    const timer = setInterval(() => {
      if (offset >= pcm.length) {
        clearInterval(timer)
        socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }))
        setTimeout(() => socket.close(), 6000)
        return
      }
      socket.send(
        JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: pcm16Base64(pcm.subarray(offset, offset + CHUNK)),
        }),
      )
      offset += CHUNK
    }, 20)
  })

  socket.on('message', (raw) => {
    const event = JSON.parse(raw.toString()) as Record<string, unknown>
    const type = String(event.type)
    counts.set(type, (counts.get(type) ?? 0) + 1)
    if (type.startsWith('input_audio_buffer') || type === 'error') {
      if (samples.length < 8) samples.push(JSON.stringify(event).slice(0, 300))
    }
  })

  await new Promise<void>((resolve) => socket.on('close', () => resolve()))

  console.log(`model: ${MODEL}  turn_detection: ${TURN_DETECTION}`)
  console.log('\nevent types:')
  for (const [type, count] of [...counts].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${count.toString().padStart(4)}  ${type}`)
  }
  console.log('\nsample payloads:')
  for (const sample of samples) console.log(`  ${sample}`)
}

main()
