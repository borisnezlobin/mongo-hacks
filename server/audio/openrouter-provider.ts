import { SAMPLE_RATE, type Segment, type StreamProvider, type Word } from './types'

const DEFAULT_OPENROUTER_URL = 'https://openrouter.ai/api/v1/audio/transcriptions'
const DEFAULT_OPENROUTER_MODEL = 'openai/whisper-large-v3'
const WINDOW_SAMPLES = SAMPLE_RATE * 20 / 1000
const MIN_SPEECH_MS = 400
const SILENCE_END_MS = 250
const SILENCE_END_MIN_SPEECH_MS = 1000
const MAX_TURN_MS = 15_000

export interface OpenRouterProviderOptions {
  apiKey: string
  model?: string
  url?: string
  fetchImpl?: typeof fetch
  silenceThreshold?: number
}

interface AudioWindow {
  samples: Float32Array
  startSample: number
  endSample: number
}

interface CompletedTurn {
  audio: Float32Array
  speaker: string
  startMs: number
  endMs: number
}

/**
 * Batch transcription has neither server VAD nor diarisation, so this adapter
 * makes each locally detected turn a unique session speaker. The identity
 * spine can then attribute its audio without this fallback guessing a person.
 */
export class OpenRouterProvider implements StreamProvider {
  private readonly fetchImpl: typeof fetch
  private readonly apiKey: string
  private readonly model: string
  private readonly url: string
  private readonly silenceThreshold: number
  private segmentHandler: (segments: Segment[]) => void = () => {}
  private wordHandler: (words: Word[]) => void = () => {}
  private readonly pendingWindow = new Float32Array(WINDOW_SAMPLES)
  private pendingWindowLength = 0
  private pendingWindowStartSample = 0
  private nextSampleCursor: number | null = null
  private turnWindows: AudioWindow[] = []
  private speechMs = 0
  private silenceMs = 0
  private lastSpeechWindow = -1
  private turnIndex = 0
  private successfulTurns = 0
  private firstFailure: Error | null = null
  private closed = false
  private closePromise: Promise<void> | null = null
  private emissionTail: Promise<void> = Promise.resolve()
  private readonly inFlight = new Set<Promise<void>>()

  constructor(options: OpenRouterProviderOptions) {
    if (!options.apiKey) throw new Error('OPENROUTER_API_KEY is required for fallback audio')
    this.apiKey = options.apiKey
    this.model = options.model ?? process.env.OPENROUTER_STT_MODEL ?? DEFAULT_OPENROUTER_MODEL
    this.url = options.url ?? DEFAULT_OPENROUTER_URL
    this.fetchImpl = options.fetchImpl ?? fetch
    this.silenceThreshold = options.silenceThreshold ?? 0.01
  }

  pushAudio(pcm: Float32Array, positionMs: number): void {
    if (this.closed || pcm.length === 0) return
    let sampleCursor = Math.round(positionMs * SAMPLE_RATE / 1000)
    if (this.nextSampleCursor !== null && sampleCursor !== this.nextSampleCursor) {
      // A stream-clock discontinuity cannot be compressed inside one batch
      // without making its synthesized timings cover audio that never arrived.
      if (this.pendingWindowLength > 0) this.flushAnalysisWindow()
      this.finishTurn()
    }
    let inputOffset = 0
    while (inputOffset < pcm.length) {
      if (this.pendingWindowLength === 0) {
        this.pendingWindowStartSample = sampleCursor
      }
      const copied = Math.min(WINDOW_SAMPLES - this.pendingWindowLength, pcm.length - inputOffset)
      this.pendingWindow.set(
        pcm.subarray(inputOffset, inputOffset + copied),
        this.pendingWindowLength,
      )
      this.pendingWindowLength += copied
      inputOffset += copied
      sampleCursor += copied
      if (this.pendingWindowLength === WINDOW_SAMPLES) this.flushAnalysisWindow()
    }
    this.nextSampleCursor = sampleCursor
  }

  onSegments(handler: (segments: Segment[]) => void): void {
    this.segmentHandler = handler
  }

  onWords(handler: (words: Word[]) => void): void {
    this.wordHandler = handler
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closed = true
    if (this.pendingWindowLength > 0) this.flushAnalysisWindow()
    this.finishTurn()
    this.closePromise = this.waitForTurns()
    return this.closePromise
  }

  private flushAnalysisWindow(): void {
    const samples = this.pendingWindow.slice(0, this.pendingWindowLength)
    const startSample = this.pendingWindowStartSample
    this.pendingWindowLength = 0
    this.processWindow(samples, startSample)
  }

  private processWindow(samples: Float32Array, startSample: number): void {
    const durationMs = samples.length * 1000 / SAMPLE_RATE
    const endSample = startSample + samples.length
    const silent = rms(samples) < this.silenceThreshold
    if (this.turnWindows.length === 0 && silent) return

    this.turnWindows.push({ samples, startSample, endSample })
    if (silent) {
      this.silenceMs += durationMs
    } else {
      this.speechMs += durationMs
      this.silenceMs = 0
      this.lastSpeechWindow = this.turnWindows.length - 1
    }

    const turnStartSample = this.turnWindows[0].startSample
    const silenceEnded =
      this.silenceMs >= SILENCE_END_MS && this.speechMs >= SILENCE_END_MIN_SPEECH_MS
    const turnDurationMs = (endSample - turnStartSample) * 1000 / SAMPLE_RATE
    if (silenceEnded || turnDurationMs >= MAX_TURN_MS) this.finishTurn()
  }

  private finishTurn(): void {
    if (this.speechMs >= MIN_SPEECH_MS && this.lastSpeechWindow >= 0) {
      const windows = this.turnWindows.slice(0, this.lastSpeechWindow + 1)
      const speaker = `turn-${this.turnIndex}`
      this.turnIndex += 1
      this.enqueueTurn({
        audio: concatenate(windows.map((window) => window.samples)),
        speaker,
        startMs: windows[0].startSample * 1000 / SAMPLE_RATE,
        endMs: windows.at(-1)!.endSample * 1000 / SAMPLE_RATE,
      })
    }
    this.turnWindows = []
    this.speechMs = 0
    this.silenceMs = 0
    this.lastSpeechWindow = -1
  }

  private enqueueTurn(turn: CompletedTurn): void {
    // Requests begin concurrently so audio ingestion never waits on the
    // network, while the emission chain preserves the stream's turn order.
    const request = this.transcribe(turn.audio)
    const emission = this.emissionTail.then(async () => {
      const text = await request
      if (text === null) return
      const startMs = Math.round(turn.startMs)
      const endMs = Math.round(turn.endMs)
      this.segmentHandler([{ speaker: turn.speaker, start_ms: startMs, end_ms: endMs }])
      this.wordHandler(spreadWords(text, startMs, endMs))
    })
    this.emissionTail = emission
    this.inFlight.add(emission)
    void emission.then(
      () => this.inFlight.delete(emission),
      () => this.inFlight.delete(emission),
    )
  }

  private async transcribe(audio: Float32Array): Promise<string | null> {
    try {
      const response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          input_audio: { data: encodeWav(audio), format: 'wav' },
          language: 'en',
        }),
      })
      if (!response.ok) {
        throw new Error(`OpenRouter transcription failed with status ${response.status}`)
      }
      const body: unknown = await response.json()
      if (!isTranscriptionResponse(body)) {
        throw new Error('OpenRouter transcription response did not include text')
      }
      this.successfulTurns += 1
      return body.text
    } catch (value) {
      const error = value instanceof Error ? value : new Error(String(value))
      this.firstFailure ??= error
      console.error('OpenRouter transcription failed', error)
      return null
    }
  }

  private async waitForTurns(): Promise<void> {
    await Promise.all([...this.inFlight, this.emissionTail])
    if (this.firstFailure && this.successfulTurns === 0) throw this.firstFailure
  }
}

function rms(samples: Float32Array): number {
  let energy = 0
  for (const sample of samples) energy += sample * sample
  return Math.sqrt(energy / samples.length)
}

function concatenate(chunks: Float32Array[]): Float32Array {
  const output = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.length
  }
  return output
}

function encodeWav(input: Float32Array): string {
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

function isTranscriptionResponse(value: unknown): value is { text: string } {
  return typeof value === 'object' && value !== null && typeof Reflect.get(value, 'text') === 'string'
}

function spreadWords(text: string, startMs: number, endMs: number): Word[] {
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
