import WebSocket from 'ws'
import { SAMPLE_RATE, type Segment, type StreamProvider, type Word } from './types'

const REALTIME_SAMPLE_RATE = 24_000
const DEFAULT_REALTIME_URL = 'wss://api.openai.com/v1/realtime?intent=transcription'
/**
 * Diarisation carries the speaker labels the join depends on, so it is the
 * default. Not every organisation is entitled to that model, hence the
 * override: OPENAI_TRANSCRIBE_MODEL swaps in a plain transcription model,
 * which still yields text but collapses every turn onto one speaker label.
 */
const DEFAULT_TRANSCRIBE_MODEL = 'gpt-4o-transcribe-diarize'

interface RealtimeSocket {
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  on(event: 'open' | 'message' | 'error' | 'close', listener: (...args: any[]) => void): void
}

export interface OpenAIRealtimeProviderOptions {
  apiKey: string
  url?: string
  model?: string
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
  private readonly model: string
  /** Stream position in ms, advanced only by ingested audio. */
  private positionMs = 0
  private turnStartMs: number | null = null
  private turnIndex = 0
  private readonly turnBounds = new Map<string, { start_ms: number; end_ms: number }>()
  /** True once a diarising model has supplied real speaker labels. */
  private diarized = false
  /** End of the previous VAD turn, so consecutive turns never overlap. */
  private lastTurnEndMs = 0

  constructor(options: OpenAIRealtimeProviderOptions) {
    if (!options.apiKey) throw new Error('OPENAI_API_KEY is required for live audio')
    this.model = options.model ?? process.env.OPENAI_TRANSCRIBE_MODEL ?? DEFAULT_TRANSCRIBE_MODEL
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    // No OpenAI-Beta header: the beta Realtime protocol was retired and the
    // GA endpoint rejects the connection outright when it is sent.
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
              transcription: { model: this.model, language: 'en' },
              turn_detection: {
                type: 'server_vad',
                threshold: 0.5,
                prefix_padding_ms: 300,
                // Short, because turn boundaries are load-bearing here: without
                // a diarising model each VAD turn is the unit that voiceprint
                // matching attributes, so conversational gaps must split.
                silence_duration_ms: Number(process.env.OPENAI_SILENCE_MS ?? 200),
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

  pushAudio(pcm: Float32Array, positionMs?: number): void {
    if (pcm.length === 0) return
    // The stream clock is the only timeline the rest of the system trusts, so
    // turn boundaries are stamped from it rather than from arrival time.
    this.positionMs =
      positionMs !== undefined
        ? positionMs + Math.round((pcm.length / SAMPLE_RATE) * 1000)
        : this.positionMs + Math.round((pcm.length / SAMPLE_RATE) * 1000)
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
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
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
    // Diarising models hand back speaker labels and timings directly. Every
    // other transcription model returns text only, so the two paths below
    // reconstruct turns from server VAD plus the stream clock instead.
    if (event.type === 'conversation.item.input_audio_transcription.segment') {
      const segment = event as TranscriptionSegmentEvent
      if (!segment.text || segment.start === undefined || segment.end === undefined) return
      this.diarized = true
      const startMs = Math.round(segment.start * 1000)
      const endMs = Math.round(segment.end * 1000)
      this.emitTurn(segment.speaker ?? 'SPEAKER_00', startMs, endMs, segment.text)
      return
    }

    // Server VAD reports its own buffer offsets, which are the position in the
    // audio we sent rather than the time the event arrived. Using them keeps
    // segment boundaries aligned with the samples even when the socket lags,
    // which matters because voiceprint matching slices audio by these times.
    if (event.type === 'input_audio_buffer.speech_started') {
      const started = event as { item_id?: string; audio_start_ms?: number }
      // VAD reports speech starting prefix_padding_ms before it really does,
      // so turns overlap and the joiner would pull one turn's tail words into
      // the next speaker's utterance. Clamped here, on the speech events,
      // because those arrive in audio order — transcription completions do
      // not, and clamping there produced degenerate one-millisecond turns.
      const startMs = Math.max(started.audio_start_ms ?? this.positionMs, this.lastTurnEndMs)
      this.turnStartMs = startMs
      if (started.item_id) {
        this.turnBounds.set(started.item_id, { start_ms: startMs, end_ms: startMs })
      }
      return
    }

    if (event.type === 'input_audio_buffer.speech_stopped') {
      const stopped = event as { item_id?: string; audio_end_ms?: number }
      const endMs = stopped.audio_end_ms ?? this.positionMs
      this.lastTurnEndMs = Math.max(this.lastTurnEndMs, endMs)
      if (stopped.item_id) {
        const bounds = this.turnBounds.get(stopped.item_id)
        this.turnBounds.set(stopped.item_id, {
          start_ms: bounds?.start_ms ?? this.turnStartMs ?? 0,
          end_ms: endMs,
        })
      }
      this.turnStartMs = null
      return
    }

    if (event.type === 'conversation.item.input_audio_transcription.completed') {
      const completed = event as { item_id?: string; transcript?: string }
      if (!this.diarized && completed.transcript?.trim()) {
        const bounds = (completed.item_id && this.turnBounds.get(completed.item_id)) || {
          start_ms: this.turnStartMs ?? 0,
          end_ms: this.positionMs,
        }
        if (completed.item_id) this.turnBounds.delete(completed.item_id)
        // One label per turn. Voiceprint matching downstream decides who each
        // turn belongs to; inventing a shared label here would merge speakers.
        this.emitTurn(
          `turn-${this.turnIndex++}`,
          bounds.start_ms,
          Math.max(bounds.end_ms, bounds.start_ms + 1),
          completed.transcript.trim(),
        )
      }
      // Only release the flush once every turn the server opened has come
      // back. Resolving on the first completion would close the socket while
      // later turns are still in flight, and the last thing said is exactly
      // what the demo depends on.
      if (this.turnBounds.size === 0) {
        this.flushComplete?.()
        this.flushComplete = null
      }
    }
  }

  private emitTurn(speaker: string, startMs: number, endMs: number, text: string): void {
    const end = Math.max(endMs, startMs + 1)
    this.segmentHandler([{ speaker, start_ms: startMs, end_ms: end }])
    this.wordHandler(spreadWords(text, startMs, end))
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
