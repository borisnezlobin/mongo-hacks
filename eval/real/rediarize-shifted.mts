/**
 * Diarizes the 48-minute recording a second time, with the chunk seams moved.
 *
 * `bun run eval:rediarize` — costs real money. Read this before running it.
 *
 * The problem it solves: the ground truth in eval/real/ground-truth.json was
 * built by pooling ECAPA over the chunked diarization and agglomerating it,
 * which is what server/audio's stitch does. Scoring the stitch against that
 * reference is substantially the reference agreeing with itself, and a 0.0%
 * that means "we used the same method twice" is worse than no number.
 *
 * The way out is cheap. The model has to be given the recording in pieces
 * because it refuses anything over 1400 s, and where those pieces are cut is
 * arbitrary. Cutting them somewhere else — offsets moved by about half a chunk
 * — gives a second labelling whose seams fall in completely different places
 * and whose within-chunk decisions are made over different context. Two runs
 * agreeing that two spans belong together is evidence that owes nothing at all
 * to any voiceprint. Two runs disagreeing is a span that belongs in `excluded`.
 *
 * The output is committed-adjacent and never regenerated casually: each run is
 * a bill. It writes fixtures/real/chunks/shift_<start>.json and a sibling
 * plan-shift.json describing how it was cut, the same way plan.json describes
 * the first run.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { realFixturePath, hasRealFixture, missingFixtureNotice } from '../../fixtures/real-audio'
import { encodeWavBytes } from '../../server/audio/wav-util'
import { readWav } from '../../server/audio/wav'
import { SAMPLE_RATE } from '../../server/audio/types'

const WAV = 'dorm-40min.wav'
const MODEL = 'gpt-4o-transcribe-diarize'
const ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions'

/**
 * Deliberately out of phase with the first run's 0/950/1900/2850.
 *
 * Roughly half a chunk over, so every seam in the first run lands in the middle
 * of a chunk here and vice versa: the first run's worst-labelled audio — the
 * seconds either side of a cut, where a speaker is sliced mid-word and the
 * model has no context — is this run's best-labelled audio.
 *
 * The head chunk is short rather than absent. Both self-introductions are in
 * the first thirty seconds and they are the most valuable ground truth in the
 * recording, so leaving 0-490 s to be covered only by the first run would spend
 * the money and skip the part it was for. A short chunk still reads that audio
 * with a different end seam and different context, which is what independence
 * means here.
 */
const SPANS: { start: number; seconds: number }[] = [
  { start: 0, seconds: 520 },
  { start: 490, seconds: 980 },
  { start: 1440, seconds: 980 },
  { start: 2390, seconds: 520 },
]
const OVERLAP = 30

interface DiarizedResponse {
  segments?: { speaker?: string; start?: number; end?: number; text?: string }[]
  duration?: number
  error?: { message?: string }
}

function loadEnv(): void {
  try {
    process.loadEnvFile(new URL('../../.env', import.meta.url).pathname)
  } catch {
    /* ambient environment */
  }
}

async function diarize(slice: Float32Array, apiKey: string): Promise<DiarizedResponse> {
  const form = new FormData()
  const bytes = encodeWavBytes(slice)
  form.append('file', new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'audio/wav' }), 'chunk.wav')
  form.append('model', MODEL)
  form.append('response_format', 'diarized_json')
  form.append('chunking_strategy', 'auto')
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  })
  const payload = (await response.json()) as DiarizedResponse
  if (!response.ok) throw new Error(`diarize ${response.status}: ${payload.error?.message ?? ''}`)
  return payload
}

async function main(): Promise<void> {
  loadEnv()
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY is required')
  if (!hasRealFixture(WAV)) {
    console.error(missingFixtureNotice(WAV))
    process.exitCode = 1
    return
  }

  const { samples, sampleRate } = readWav(readFileSync(realFixturePath(WAV)))
  if (sampleRate !== SAMPLE_RATE) throw new Error(`fixture is ${sampleRate} Hz`)
  const directory = realFixturePath('chunks')
  mkdirSync(directory, { recursive: true })

  const force = process.argv.includes('--force')
  for (const { start, seconds } of SPANS) {
    const path = `${directory}/shift_${start}.json`
    if (existsSync(path) && !force) {
      // Refusing to overwrite is the whole safety story here. Every one of
      // these files is a bill somebody already paid.
      console.log(`  ${start}s already exists, skipping (pass --force to pay again)`)
      continue
    }
    const slice = samples.subarray(
      start * SAMPLE_RATE,
      Math.min(samples.length, (start + seconds) * SAMPLE_RATE),
    )
    console.log(`  ${start}s → ${(slice.length / SAMPLE_RATE).toFixed(0)}s of audio…`)
    const payload = await diarize(slice, apiKey)
    const segments = (payload.segments ?? [])
      .filter((segment) => segment.speaker && segment.start !== undefined && segment.end !== undefined)
      .map((segment) => ({
        speaker: segment.speaker as string,
        start: segment.start as number,
        end: segment.end as number,
        text: (segment.text ?? '').trim(),
      }))
      .sort((a, b) => a.start - b.start)
    writeFileSync(path, JSON.stringify({ segments }, null, 1))
    const speakers = new Set(segments.map((segment) => segment.speaker))
    console.log(`    ${segments.length} segments, ${speakers.size} labels → ${path}`)
  }

  writeFileSync(
    `${directory}/plan-shift.json`,
    JSON.stringify({ spans: SPANS, overlap: OVERLAP, model: MODEL }),
  )
  console.log('\nwrote plan-shift.json')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
