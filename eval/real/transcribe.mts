/**
 * Batch-transcribe a real recording into the verbose_json fixture the rest of
 * the pipeline reads.
 *
 * `bun run eval:transcribe <stem>` — costs real money, about a cent a minute of
 * audio. The fixtures in fixtures/real/*.whisper.json were previously produced
 * by hand, one curl per recording, which is fine until the recording is longer
 * than the 25 MB upload cap and has to be cut into pieces that agree about
 * where time zero is. This does the same job as `transcribeWithTimings` and
 * writes the *raw* payload shape instead of a TimedTranscript, because every
 * downstream reader — build_transcript.py, whisper_sentences.py,
 * readTimedTranscript — expects the API's own `{word, start, end}` seconds and
 * applies its own punctuation restoration. Writing the processed shape here
 * would restore punctuation twice.
 *
 * Seams come from `planChunks`, so a cut lands in the quietest moment near the
 * limit rather than through the middle of a word.
 *
 * Each chunk's response is cached under fixtures/real/chunks/ before anything
 * is merged. A failure in the eleventh chunk of a thirteen-chunk recording
 * should not make you pay for the first ten again.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { realFixturePath, hasRealFixture, missingFixtureNotice } from '../../fixtures/real-audio'
import { encodeWavBytes } from '../../server/audio/wav-util'
import { readWav } from '../../server/audio/wav'
import { SAMPLE_RATE } from '../../server/audio/types'
import { planChunks, type WhisperResponse } from '../../server/audio/whisper-client'
import { repairRepeatLoops } from '../../server/audio/loop-repair'

const ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions'
const MODEL = process.env.OPENAI_WHISPER_MODEL ?? 'whisper-1'

function loadEnv(): void {
  try {
    process.loadEnvFile(new URL('../../.env', import.meta.url).pathname)
  } catch {
    /* ambient environment */
  }
}

async function transcribeChunk(slice: Float32Array, apiKey: string): Promise<WhisperResponse> {
  const form = new FormData()
  const bytes = encodeWavBytes(slice)
  form.append('file', new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'audio/wav' }), 'chunk.wav')
  form.append('model', MODEL)
  form.append('response_format', 'verbose_json')
  form.append('timestamp_granularities[]', 'segment')
  form.append('timestamp_granularities[]', 'word')
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  })
  const payload = (await response.json()) as WhisperResponse
  if (!response.ok) throw new Error(`transcribe ${response.status}: ${payload.error?.message ?? ''}`)
  return payload
}

async function main(): Promise<void> {
  loadEnv()
  const stem = process.argv[2]
  if (!stem) throw new Error('usage: tsx eval/real/transcribe.mts <stem> [--force]')
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY is required')
  if (!hasRealFixture(`${stem}.wav`)) {
    console.error(missingFixtureNotice(`${stem}.wav`))
    process.exitCode = 1
    return
  }

  const out = realFixturePath(`${stem}.whisper.json`)
  const force = process.argv.includes('--force')
  if (existsSync(out) && !force) {
    console.log(`${out} already exists — pass --force to pay for it again`)
    return
  }

  const { samples, sampleRate } = readWav(readFileSync(realFixturePath(`${stem}.wav`)))
  if (sampleRate !== SAMPLE_RATE) throw new Error(`fixture is ${sampleRate} Hz, expected ${SAMPLE_RATE}`)
  const cache = realFixturePath('chunks')
  mkdirSync(cache, { recursive: true })

  const spans = planChunks(samples)
  const duration = samples.length / SAMPLE_RATE
  console.log(`${stem}: ${(duration / 60).toFixed(1)} min in ${spans.length} chunk(s), model ${MODEL}`)

  const words: { word: string; start: number; end: number }[] = []
  const segments: { start: number; end: number; text: string }[] = []
  const texts: string[] = []

  for (const span of spans) {
    const offset = span.from / SAMPLE_RATE
    const path = `${cache}/${stem}.whisper.${Math.round(offset)}.json`
    let payload: WhisperResponse
    if (existsSync(path)) {
      payload = JSON.parse(readFileSync(path, 'utf8')) as WhisperResponse
      console.log(`  ${offset.toFixed(0)}s cached`)
    } else {
      const seconds = (span.to - span.from) / SAMPLE_RATE
      console.log(`  ${offset.toFixed(0)}s → ${seconds.toFixed(0)}s of audio…`)
      payload = await transcribeChunk(samples.subarray(span.from, span.to), apiKey)
      writeFileSync(path, JSON.stringify(payload))
    }
    texts.push((payload.text ?? '').trim())
    for (const word of payload.words ?? []) {
      if (word.start === undefined || word.end === undefined) continue
      words.push({ word: word.word ?? '', start: word.start + offset, end: word.end + offset })
    }
    for (const segment of payload.segments ?? []) {
      if (segment.start === undefined || segment.end === undefined) continue
      segments.push({
        start: segment.start + offset,
        end: segment.end + offset,
        text: (segment.text ?? '').trim(),
      })
    }
  }

  words.sort((a, b) => a.start - b.start)
  segments.sort((a, b) => a.start - b.start)

  // Same repair the live pass runs, over the same code. Cached per span for the
  // same reason the chunks are: a re-decode of a five-minute run is a bill too.
  const repaired = await repairRepeatLoops(
    { segments, words, text: texts.join(' ').trim() },
    async (from, to) => {
      const path = `${cache}/${stem}.repair.${Math.round(from)}-${Math.round(to)}.json`
      if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8')) as WhisperResponse
      const slice = samples.subarray(Math.round(from * SAMPLE_RATE), Math.round(to * SAMPLE_RATE))
      const payload = await transcribeChunk(slice, apiKey)
      writeFileSync(path, JSON.stringify(payload))
      return payload
    },
    {
      duration,
      onReport: (report) => {
        console.log(`\n${report.runs.length} repetition run(s):`)
        for (const run of [...report.repaired, ...report.kept].sort((a, b) => a.from - b.from)) {
          const verdict = report.repaired.includes(run) ? 're-decoded' : 'kept'
          console.log(
            `  ${Math.floor(run.from / 60)}:${String(Math.floor(run.from % 60)).padStart(2, '0')} ` +
              `x${run.count} ${JSON.stringify(run.text.slice(0, 40))} → ${verdict}`,
          )
        }
      },
    },
  )

  writeFileSync(
    out,
    JSON.stringify({ task: 'transcribe', language: 'english', duration, ...repaired }),
  )
  console.log(
    `\n${repaired.words?.length ?? 0} words, ${repaired.segments?.length ?? 0} segments → ${out}`,
  )
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
