import WebSocket from 'ws'
import { SAMPLE_RATE, type Segment, type StreamProvider, type Word } from './types'

const REALTIME_SAMPLE_RATE = 24_000
const DEFAULT_REALTIME_URL = 'wss://api.openai.com/v1/realtime?intent=transcription'

interface RealtimeSocket {
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  on(event: 'open' | 'message' | 'error' | 'close', listener: (...args: any[]) => void): void
}

export interface OpenAIRealtimeProviderOptions {
  apiKey: string
  url?: string
  socketFactory?: (url: string, headers: Record<string, string>) => RealtimeSocket
}

interface TranscriptionSegmentEvent {
  type: 'conversation.item.input_audio_transcription.segment'
  speaker?: string
  text?: string
  start?: number
  end?: number
}

/**
 * Live transcription and diarisation through OpenAI Realtime. Fixture text is
 * deliberately absent from this adapter: a live microphone can only produce
 * provider output, never canned demo output.
 */
export class OpenAIRealtimeProvider implements StreamProvider {
  private readonly socket: RealtimeSocket
  private segmentHandler: (segments: Segment[]) => void = () => {}
  private wordHandler: (words: Word[]) => void = () => {}
  private opened = false
  private closed = false
  private sentAudio = false
  private failure: Error | null = null
  private flushComplete: (() => void) | null = null
  private readonly pendingAudio: string[] = []
  private readonly ready: Promise<void>
  private resolveReady: (() => void) | null = null
  private rejectReady: ((error: Error) => void) | null = null

  constructor(options: OpenAIRealtimeProviderOptions) {
    if (!options.apiKey) throw new Error('OPENAI_API_KEY is required for live audio')
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    // No 'OpenAI-Beta: realtime=v1' header: that opts into the retired Beta API, which now
    // rejects the connection outright ("The Realtime Beta API is no longer supported").
    // The session.update payload below is already the GA shape.
    const headers = {
      Authorization: `Bearer ${options.apiKey}`,
    }
    this.socket = options.socketFactory
      ? options.socketFactory(options.url ?? DEFAULT_REALTIME_URL, headers)
      : new WebSocket(options.url ?? DEFAULT_REALTIME_URL, { headers })
    this.bindSocket()
  }

  private bindSocket(): void {
    this.socket.on('open', () => {
      this.opened = true
      this.send({
        type: 'session.update',
        session: {
          type: 'transcription',
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: REALTIME_SAMPLE_RATE },
              transcription: { model: 'gpt-4o-transcribe-diarize', language: 'en' },
              turn_detection: {
                type: 'server_vad',
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 500,
              },
            },
          },
        },
      })
      for (const audio of this.pendingAudio.splice(0)) this.append(audio)
      this.resolveReady?.()
    })
    this.socket.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
      const bytes = Array.isArray(raw)
        ? Buffer.concat(raw)
        : Buffer.isBuffer(raw)
          ? raw
          : Buffer.from(raw)
      const text = bytes.toString()
      try {
        this.handleEvent(JSON.parse(text) as { type?: string })
      } catch (value) {
        this.failure = value instanceof Error ? value : new Error(String(value))
        this.socket.close(1011, 'provider error')
      }
    })
    this.socket.on('error', (value: unknown) => {
      const error = value instanceof Error ? value : new Error(String(value))
      if (!this.opened) this.rejectReady?.(error)
    })
    this.socket.on('close', () => {
      this.closed = true
      if (!this.opened) this.rejectReady?.(new Error('Realtime socket closed before opening'))
    })
  }

  pushAudio(pcm: Float32Array): void {
    if (pcm.length === 0) return
    this.sentAudio = true
    const audio = pcm16Base64(resampleLinear(pcm, SAMPLE_RATE, REALTIME_SAMPLE_RATE))
    if (this.opened) this.append(audio)
    else if (!this.closed) this.pendingAudio.push(audio)
  }

  onSegments(handler: (segments: Segment[]) => void): void {
    this.segmentHandler = handler
  }

  onWords(handler: (words: Word[]) => void): void {
    this.wordHandler = handler
  }

  async close(): Promise<void> {
    if (this.closed) {
      if (this.failure) throw this.failure
      return
    }
    await this.ready
    // Server VAD commits normal turns. This final commit flushes a trailing
    // turn that ended exactly when capture stopped.
    if (this.sentAudio) {
      const flushed = new Promise<void>((resolve) => {
        this.flushComplete = resolve
      })
      this.send({ type: 'input_audio_buffer.commit' })
      await Promise.race([
        flushed,
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ])
    }
    this.socket.close(1000, 'stream complete')
    if (this.failure) throw this.failure
  }

  private append(audio: string): void {
    this.send({ type: 'input_audio_buffer.append', audio })
  }

  private send(event: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(event))
  }

  private handleEvent(event: { type?: string }): void {
    if (event.type === 'error') {
      const detail = event as { error?: { message?: string } }
      throw new Error(detail.error?.message ?? 'OpenAI Realtime error')
    }
    if (event.type === 'conversation.item.input_audio_transcription.completed') {
      this.flushComplete?.()
      this.flushComplete = null
      return
    }
    if (event.type !== 'conversation.item.input_audio_transcription.segment') return
    const segment = event as TranscriptionSegmentEvent
    if (!segment.text || segment.start === undefined || segment.end === undefined) return
    const startMs = Math.round(segment.start * 1000)
    const endMs = Math.round(segment.end * 1000)
    const speaker = segment.speaker ?? 'SPEAKER_00'
    this.segmentHandler([{ speaker, start_ms: startMs, end_ms: endMs }])
    this.wordHandler(spreadWords(segment.text, startMs, endMs))
  }
}

export function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input.slice()
  if (input.length === 0) return new Float32Array()
  const output = new Float32Array(Math.round(input.length * toRate / fromRate))
  const ratio = fromRate / toRate
  for (let index = 0; index < output.length; index += 1) {
    const position = index * ratio
    const left = Math.floor(position)
    const right = Math.min(left + 1, input.length - 1)
    const weight = position - left
    output[index] = input[left] * (1 - weight) + input[right] * weight
  }
  return output
}

function pcm16Base64(input: Float32Array): string {
  const bytes = Buffer.allocUnsafe(input.length * 2)
  for (let index = 0; index < input.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, input[index]))
    bytes.writeInt16LE(sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767), index * 2)
  }
  return bytes.toString('base64')
}

function spreadWords(text: string, startMs: number, endMs: number): Word[] {
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
