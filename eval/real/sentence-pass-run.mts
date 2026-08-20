/**
 * Run the SHIPPED sentence pass over a saved recording and write its turns.
 *
 * `eval/real/sentence_pooled.py` is the exploration harness; this is the code
 * that actually runs in `server/audio/session.ts`, driven over the same ECAPA
 * sidecar, so the fixture the measured test scores is produced by the
 * implementation rather than by a probe that resembles it.
 *
 *   SIDECAR_URL=http://127.0.0.1:8099 npx tsx eval/real/sentence-pass-run.mts <stem>
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { embedPcm, embedPcmForClustering } from '../../server/audio/embed-client'
import type { SpeakerTurn } from '../../server/audio/diarize-sidecar'
import { readWav } from '../../server/audio/wav'
import { SAMPLE_RATE } from '../../server/audio/types'
import { readTimedTranscript, type WhisperResponse } from '../../server/audio/whisper-client'
import { readRealFixture, realFixturePath } from '../../fixtures/real-audio'
import {
  bestPool,
  concatSamples,
  poolableStretches,
  rewriteTurns,
  sentencesFromWords,
  stretchesWithinBudget,
  SENTENCE_TRUST_MS,
} from '../../server/audio/sentence-pass'

const stem = process.argv[2]
const transcript = readTimedTranscript(readRealFixture<WhisperResponse>(`${stem}.whisper.json`))
const turns = readRealFixture<{ turns: SpeakerTurn[] }>(`${stem}.pyannote.json`).turns
const samples = readWav(readFileSync(realFixturePath(`${stem}.wav`))).samples

const slice = (start_ms: number, end_ms: number) =>
  samples.subarray(
    Math.max(0, Math.round((start_ms / 1000) * SAMPLE_RATE)),
    Math.min(samples.length, Math.round((end_ms / 1000) * SAMPLE_RATE)),
  )

const started = Date.now()
const pools = new Map<string, number[]>()
for (const [speaker, stretches] of poolableStretches(turns)) {
  const pooled = concatSamples(
    stretchesWithinBudget(stretches).map((span) => slice(span.start_ms, span.end_ms)),
  )
  if (pooled.length < 3 * SAMPLE_RATE) continue
  pools.set(speaker, (await embedPcm(pooled)).vector)
}

const sentences =
  transcript.segments.length > 0
    ? transcript.segments
    : sentencesFromWords(transcript.words).filter((sentence) => sentence.terminated)

const attributed: SpeakerTurn[] = []
for (const sentence of sentences) {
  if (sentence.end_ms - sentence.start_ms < SENTENCE_TRUST_MS) continue
  const clip = slice(sentence.start_ms, sentence.end_ms)
  if (clip.length === 0) continue
  const speaker = bestPool((await embedPcmForClustering(clip)).vector, pools)
  if (speaker) attributed.push({ start_ms: sentence.start_ms, end_ms: sentence.end_ms, speaker })
}

const out = rewriteTurns(turns, attributed)
const path = realFixturePath(`${stem}.sentpool.json`)
writeFileSync(path, JSON.stringify({ turns: out }))
console.log(
  `${stem}: ${pools.size} pools, ${attributed.length} of ${sentences.length} sentences attributed, ` +
    `${out.length} turns, ${((Date.now() - started) / 1000).toFixed(1)}s -> ${path}`,
)
