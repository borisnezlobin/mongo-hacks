import { SAMPLE_RATE, type Segment, type StreamProvider, type Word } from './types'
import { concatenate, encodeWav, rms, spreadWords } from './wav-util'

/**
 * pyannote's hosted diarization (`PYANNOTE_API_KEY`) returns speaker-homogeneous
 * segments over a finished clip; it does not transcribe. The honest composition
 * is: accumulate a turn with local VAD, diarize it with pyannote to get true
 * session speakers, then transcribe each speaker segment with OpenRouter so the
 * word stream still lands inside the right diarization span.
 *
 * This exists because OpenAI Realtime's diarize model is not entitled for every
 * org — when it is not, this is the real diarization path rather than the
 * one-speaker-per-turn OpenRouter fallback.
 */

const DEFAULT_PYANNOTE_URL = 'https://api.pyannote.ai/v1/diarize'
const DEFAULT_OPENROUTER_URL = 'https://openrouter.ai/api/v1/audio/transcriptions'
const DEFAULT_OPENROUTER_MODEL = 'openai/whisper-large-v3'

const WINDOW_SAMPLES = (SAMPLE_RATE * 20) / 1000
const MIN_SPEECH_MS = 400
const SILENCE_END_MS = 250
const SILENCE_END_MIN_SPEECH_MS = 1000
const MAX_TURN_MS = 20_000

export interface PyannoteProviderOptions {
  pyannoteApiKey: string
  openrouterApiKey: string
  openrouterModel?: string
  pyannoteUrl?: string
  openrouterUrl?: string
  fetchImpl?: typeof fetch
  silenceThreshold?: number
}

interface AudioWindow {
  samples: Float32Array
  startSample: number
  endSample: number
}

interface PyannoteSegment {
  start: number
  end: number
  speaker: string
}

export class PyannoteProvider implements StreamProvider {
  private readonly fetchImpl: typeof fetch
  private readonly pyannoteApiKey: string
  private readonly openrouterApiKey: string
  private readonly openrouterModel: string
  private readonly pyannoteUrl: string
  private readonly openrouterUrl: string
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
  private closed = false
  private closePromise: Promise<void> | null = null
  private emissionTail: Promise<void> = Promise.resolve()
  private readonly inFlight = new Set<Promise<void>>()
  private successfulTurns = 0
  private firstFailure: Error | null = null

  constructor(options: PyannoteProviderOptions) {
    if (!options.pyannoteApiKey) throw new Error('PYANNOTE_API_KEY is required for pyannote diarization')
    if (!options.openrouterApiKey) throw new Error('OPENROUTER_API_KEY is required to transcribe pyannote segments')
    this.pyannoteApiKey = options.pyannoteApiKey
    this.openrouterApiKey = options.openrouterApiKey
    this.openrouterModel = options.openrouterModel ?? process.env.OPENROUTER_STT_MODEL ?? DEFAULT_OPENROUTER_MODEL
    this.pyannoteUrl = options.pyannoteUrl ?? DEFAULT_PYANNOTE_URL
    this.openrouterUrl = options.openrouterUrl ?? DEFAULT_OPENROUTER_URL
    this.fetchImpl = options.fetchImpl ?? fetch
    this.silenceThreshold = options.silenceThreshold ?? 0.01
  }

  pushAudio(pcm: Float32Array, positionMs: number): void {
    if (this.closed || pcm.length === 0) return
    let sampleCursor = Math.round((positionMs * SAMPLE_RATE) / 1000)
    if (this.nextSampleCursor !== null && sampleCursor !== this.nextSampleCursor) {
      if (this.pendingWindowLength > 0) this.flushAnalysisWindow()
      this.finishTurn()
    }
    let inputOffset = 0
    while (inputOffset < pcm.length) {
      if (this.pendingWindowLength === 0) this.pendingWindowStartSample = sampleCursor
      const copied = Math.min(WINDOW_SAMPLES - this.pendingWindowLength, pcm.length - inputOffset)
      this.pendingWindow.set(pcm.subarray(inputOffset, inputOffset + copied), this.pendingWindowLength)
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
    const durationMs = (samples.length * 1000) / SAMPLE_RATE
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
    const silenceEnded = this.silenceMs >= SILENCE_END_MS && this.speechMs >= SILENCE_END_MIN_SPEECH_MS
    const turnDurationMs = ((endSample - turnStartSample) * 1000) / SAMPLE_RATE
    if (silenceEnded || turnDurationMs >= MAX_TURN_MS) this.finishTurn()
  }

  private finishTurn(): void {
    if (this.speechMs >= MIN_SPEECH_MS && this.lastSpeechWindow >= 0) {
      const windows = this.turnWindows.slice(0, this.lastSpeechWindow + 1)
      const audio = concatenate(windows.map((w) => w.samples))
      const turnStartMs = (windows[0].startSample * 1000) / SAMPLE_RATE
      this.enqueueTurn(audio, turnStartMs)
    }
    this.turnWindows = []
    this.speechMs = 0
    this.silenceMs = 0
    this.lastSpeechWindow = -1
  }

  private enqueueTurn(audio: Float32Array, turnStartMs: number): void {
    const request = this.diarize(audio, turnStartMs)
    const emission = this.emissionTail.then(async () => {
      const segments = await request
      if (segments === null) return
      this.segmentHandler(segments)
      // Transcribe inside each diarized span so words carry the true speaker's
      // timing. Segment audio is sliced by its offset within the turn.
      for (const segment of segments) {
        const startSample = Math.round(((segment.start_ms - turnStartMs) * SAMPLE_RATE) / 1000)
        const endSample = Math.round(((segment.end_ms - turnStartMs) * SAMPLE_RATE) / 1000)
        const clip = audio.subarray(Math.max(0, startSample), Math.min(audio.length, endSample))
        if (clip.length < SAMPLE_RATE / 4) continue
        const text = await this.transcribe(clip)
        if (text) this.wordHandler(spreadWords(text, segment.start_ms, segment.end_ms))
      }
      this.successfulTurns += 1
    })
    this.emissionTail = emission
    this.inFlight.add(emission)
    void emission.then(
      () => this.inFlight.delete(emission),
      () => this.inFlight.delete(emission),
    )
  }

  private async diarize(audio: Float32Array, turnStartMs: number): Promise<Segment[] | null> {
    try {
      const response = await this.fetchImpl(this.pyannoteUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.pyannoteApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ audio: encodeWav(audio), sample_rate: SAMPLE_RATE }),
      })
      if (!response.ok) throw new Error(`pyannote diarize failed with status ${response.status}`)
      const body: unknown = await response.json()
      const raw = isDiarizeResponse(body) ? body.segments : null
      if (!raw) throw new Error('pyannote diarize response had no segments')
      return raw.map((segment) => ({
        speaker: segment.speaker,
        start_ms: Math.round(turnStartMs + segment.start * 1000),
        end_ms: Math.round(turnStartMs + segment.end * 1000),
      }))
    } catch (value) {
      const error = value instanceof Error ? value : new Error(String(value))
      this.firstFailure ??= error
      console.error('pyannote diarization failed', error)
      return null
    }
  }

  private async transcribe(audio: Float32Array): Promise<string | null> {
    try {
      const response = await this.fetchImpl(this.openrouterUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.openrouterApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.openrouterModel,
          input_audio: { data: encodeWav(audio), format: 'wav' },
          language: 'en',
        }),
      })
      if (!response.ok) throw new Error(`OpenRouter transcription failed with status ${response.status}`)
      const body: unknown = await response.json()
      if (!isTranscriptionResponse(body)) throw new Error('OpenRouter transcription response did not include text')
      return body.text
    } catch (value) {
      const error = value instanceof Error ? value : new Error(String(value))
      this.firstFailure ??= error
      console.error('pyannote-segment transcription failed', error)
      return null
    }
  }

  private async waitForTurns(): Promise<void> {
    await Promise.all([...this.inFlight, this.emissionTail])
    if (this.firstFailure && this.successfulTurns === 0) throw this.firstFailure
  }
}

function isDiarizeResponse(value: unknown): value is { segments: PyannoteSegment[] } {
  if (typeof value !== 'object' || value === null) return false
  const segments = Reflect.get(value, 'segments')
  return (
    Array.isArray(segments) &&
    segments.every(
      (s) =>
        typeof s === 'object' &&
        s !== null &&
        typeof Reflect.get(s, 'start') === 'number' &&
        typeof Reflect.get(s, 'end') === 'number' &&
        typeof Reflect.get(s, 'speaker') === 'string',
    )
  )
}

function isTranscriptionResponse(value: unknown): value is { text: string } {
  return typeof value === 'object' && value !== null && typeof Reflect.get(value, 'text') === 'string'
}
