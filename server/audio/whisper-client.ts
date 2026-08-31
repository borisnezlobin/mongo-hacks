/**
 * Batch transcription with word and segment timings, for the final pass.
 *
 * Not a diarizer — whisper-1 has no idea who is speaking, and that is the point
 * of using it. Asking one model for words and speakers at once, over chunks of
 * seven-way crosstalk, is what produced the fragments the owner called a bad
 * transcript. Here whisper does the one thing it is good at: it reads a whole
 * recording coherently, and gives a start and an end for every word so that
 * pyannote's speakers can be joined onto it a word at a time.
 *
 * The word timings are the load-bearing output. Segment boundaries drawn with
 * hindsight are nice; a start and end per word is what makes it possible to cut
 * a sentence at the point where somebody else started talking.
 */

import { audioConfig } from './config'
import { repairRepeatLoops, type RepairReport } from './loop-repair'
import { restorePunctuation } from './punctuation'
import { SAMPLE_RATE } from './types'
import { encodeWavBytes } from './wav-util'
import { readWav } from './wav'

export interface TimedTranscript {
  /** VAD-free segment boundaries drawn over the whole file. */
  segments: { start_ms: number; end_ms: number; text: string }[]
  words: { text: string; start_ms: number; end_ms: number }[]
  text: string
}

export interface WhisperResponse {
  text?: string
  segments?: { id?: number; start?: number; end?: number; text?: string }[]
  words?: { word?: string; start?: number; end?: number }[]
  error?: { message?: string }
}

const ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions'

/** About 15 s for three minutes of audio; the ceiling is for long sessions. */
const TIMEOUT_MS = 10 * 60 * 1000

/**
 * Turn candidate proper nouns into a whisper prompt.
 *
 * Whisper takes a free-text prompt and biases decoding toward the words in it,
 * which is the only lever available on the errors that matter most here: names.
 * Measured on a 140 s excerpt of the dorm recording, "ask how Alara is moving"
 * came back as "ask how Earth is moving" bare and correctly with a vocabulary
 * prompt, and "pure math" came back as "Pure Matt" bare and correctly prompted.
 *
 * It is also how you get whisper to delete a sentence nobody noticed was gone —
 * see the measurement on AudioConfig.vocabularyEnabled, which is why it is off.
 * Callers supply the vocabulary; this module never decides what is in it.
 */
export function vocabularyPrompt(terms: readonly string[]): string {
  const unique = [...new Set(terms.map((term) => term.trim()).filter(Boolean))]
  if (unique.length === 0) return ''
  return `The following names and terms may be mentioned: ${unique.join(', ')}.`
}

/**
 * whisper-1's prompt is capped near 224 tokens, so a vocabulary cannot be a
 * contact list. It also must not be one: every extra term is another word the
 * decoder can insert where nobody said it, and the measured insertion rate
 * rises with terms that are not actually present. The selection rule that
 * follows from that is "people already believed to be in this conversation
 * first, recently-seen people after", and it belongs to whoever owns the people
 * store — this module only truncates.
 */
export const VOCABULARY_MAX_TERMS = 24

/**
 * The upload cap, minus room for the WAV header and for the API counting bytes
 * slightly differently than we do.
 *
 * The published limit is 25 MB. At 16 kHz mono 16-bit that is 13 minutes of
 * audio, and the first real conversation this product recorded was 48 — so
 * sending the file whole, which is what this used to do, fails outright on
 * exactly the recordings whose speakers are worth the most.
 */
const MAX_UPLOAD_BYTES = 24 * 1024 * 1024

/**
 * How far back from a chunk boundary to look for somewhere quiet to cut.
 *
 * A cut through the middle of a word loses it from both chunks. Whisper needs
 * context either side, so the seam is placed at the quietest moment in the last
 * half-minute of the chunk rather than at the byte limit itself — which on
 * ordinary conversation is a pause between sentences.
 */
const SEAM_SEARCH_MS = 30_000
const SEAM_WINDOW_MS = 400

export interface TranscribeOptions {
  apiKey?: string
  model?: string
  signal?: AbortSignal
  /** Candidate proper nouns, most likely first. Truncated to VOCABULARY_MAX_TERMS. */
  vocabulary?: readonly string[]
  /**
   * Re-decode stretches where the decoder repeated one line, and keep whichever
   * answer the isolated decode gives. On by default: a loop is not cosmetic, it
   * stands where real speech was. See loop-repair.ts.
   */
  repairLoops?: boolean
  onRepairReport?: (report: RepairReport) => void
}

export async function transcribeWithTimings(
  wav: Uint8Array,
  options: TranscribeOptions = {},
): Promise<TimedTranscript> {
  return readTimedTranscript(await transcribeRaw(wav, options))
}

/**
 * The same pass, as the API's own payload shape.
 *
 * The fixtures in fixtures/real/*.whisper.json are verbose_json bodies, and
 * every reader of them calls `readTimedTranscript` itself — which restores
 * punctuation. A script that saved the processed shape here would have it
 * restored a second time on the way back in, so the recording pipeline and the
 * live pass share this and differ only in whether they save the result.
 */
export async function transcribeRaw(
  wav: Uint8Array,
  options: TranscribeOptions = {},
): Promise<WhisperResponse> {
  const { samples } = readWav(Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength))
  const spans = planChunks(samples, MAX_UPLOAD_BYTES)

  const parts: WhisperResponse[] = []
  const offsets: number[] = []
  for (const span of spans) {
    offsets.push(span.from / SAMPLE_RATE)
    // A recording that already fits is sent as it arrived rather than re-encoded
    // from the decoded samples, so nothing about the bytes depends on this path.
    const bytes = spans.length === 1 ? wav : encodeWavBytes(samples.subarray(span.from, span.to))
    parts.push(await transcribeOne(bytes, options))
  }
  const merged = mergeRaw(parts, offsets)
  if (options.repairLoops === false) return merged

  const duration = samples.length / SAMPLE_RATE
  return repairRepeatLoops(
    merged,
    async (from, to) =>
      transcribeOne(
        encodeWavBytes(samples.subarray(Math.round(from * SAMPLE_RATE), Math.round(to * SAMPLE_RATE))),
        options,
      ),
    { duration, onReport: options.onRepairReport },
  )
}

/** Chunk payloads as one payload, every time shifted onto the whole recording. */
function mergeRaw(parts: readonly WhisperResponse[], offsets: readonly number[]): WhisperResponse {
  return {
    text: parts.map((part) => (part.text ?? '').trim()).filter(Boolean).join(' '),
    segments: parts.flatMap((part, index) =>
      (part.segments ?? [])
        .filter((segment) => segment.start !== undefined && segment.end !== undefined)
        .map((segment) => ({
          start: (segment.start as number) + offsets[index],
          end: (segment.end as number) + offsets[index],
          text: (segment.text ?? '').trim(),
        })),
    ),
    words: parts.flatMap((part, index) =>
      (part.words ?? [])
        .filter((word) => word.start !== undefined && word.end !== undefined)
        .map((word) => ({
          word: word.word ?? '',
          start: (word.start as number) + offsets[index],
          end: (word.end as number) + offsets[index],
        })),
    ),
  }
}

/**
 * Cut the recording into uploadable pieces, seamed at the quietest moment near
 * each boundary. Exported for the test that checks the seams land in silence.
 */
export function planChunks(
  samples: Float32Array,
  maxBytes: number = MAX_UPLOAD_BYTES,
): { from: number; to: number }[] {
  const maxSamples = Math.floor((maxBytes - 44) / 2)
  const spans: { from: number; to: number }[] = []
  let from = 0
  while (samples.length - from > maxSamples) {
    spans.push({ from, to: quietestCut(samples, from, from + maxSamples) })
    from = spans[spans.length - 1].to
  }
  spans.push({ from, to: samples.length })
  return spans
}

/** The midpoint of the quietest short window in the run-up to a hard limit. */
function quietestCut(samples: Float32Array, from: number, limit: number): number {
  const window = (SEAM_WINDOW_MS * SAMPLE_RATE) / 1000
  const searchFrom = Math.max(from + window, limit - (SEAM_SEARCH_MS * SAMPLE_RATE) / 1000)
  let best = limit
  let quietest = Number.POSITIVE_INFINITY
  for (let at = searchFrom; at + window <= limit; at += window) {
    let energy = 0
    for (let i = at; i < at + window; i += 1) energy += samples[i] * samples[i]
    if (energy < quietest) {
      quietest = energy
      best = at + window / 2
    }
  }
  return Math.round(best)
}

async function transcribeOne(wav: Uint8Array, options: TranscribeOptions): Promise<WhisperResponse> {
  const config = audioConfig()
  const apiKey = options.apiKey ?? config.openaiApiKey
  if (!apiKey) throw new Error('OPENAI_API_KEY is required for the final transcription pass')

  const form = new FormData()
  form.append('file', new Blob([wav.slice().buffer as ArrayBuffer], { type: 'audio/wav' }), 'session.wav')
  form.append('model', options.model ?? config.whisperModel)
  form.append('response_format', 'verbose_json')
  // Both granularities: segments give turn boundaries, words give the join.
  form.append('timestamp_granularities[]', 'segment')
  form.append('timestamp_granularities[]', 'word')
  const prompt = vocabularyPrompt((options.vocabulary ?? []).slice(0, VOCABULARY_MAX_TERMS))
  if (prompt) form.append('prompt', prompt)

  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS)
  options.signal?.addEventListener('abort', () => abort.abort())
  let response: Response
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: abort.signal,
    })
  } finally {
    clearTimeout(timer)
  }

  const payload = (await response.json()) as WhisperResponse
  if (!response.ok) {
    throw new Error(
      `transcription failed (${response.status}): ${payload.error?.message ?? JSON.stringify(payload)}`,
    )
  }
  return payload
}

/**
 * A verbose_json body as a TimedTranscript, punctuation and all.
 *
 * Exported because the fixture paths — the seed script, the diarization eval,
 * the measured join tests — replay saved verbose_json bodies rather than paying
 * for the API again, and each of them used to re-map `words` by hand. Every one
 * of those copies produced the bare, unpunctuated stream. There is one reader
 * now so the replayed path and the live path cannot disagree about what a
 * transcript word looks like.
 */
export function readTimedTranscript(payload: WhisperResponse): TimedTranscript {
  const segments = (payload.segments ?? [])
    .filter((segment) => segment.start !== undefined && segment.end !== undefined)
    .map((segment) => ({
      start_ms: Math.round((segment.start as number) * 1000),
      end_ms: Math.round((segment.end as number) * 1000),
      text: (segment.text ?? '').trim(),
    }))
    .sort((a, b) => a.start_ms - b.start_ms)
  const words = (payload.words ?? [])
    .filter((word) => word.start !== undefined && word.end !== undefined)
    .map((word) => ({
      text: (word.word ?? '').trim(),
      start_ms: Math.round((word.start as number) * 1000),
      end_ms: Math.round((word.end as number) * 1000),
    }))
    .sort((a, b) => a.start_ms - b.start_ms)
  return { text: payload.text ?? '', segments, words: restorePunctuation(words, segments) }
}
