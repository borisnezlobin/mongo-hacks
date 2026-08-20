/**
 * Can the words say where the speaker changed, when the audio cannot?
 *
 * The audio has a floor: below about two seconds this microphone cannot tell
 * these people apart, and pyannote's segmentation puts a boundary within 250 ms
 * of a reference speaker change only 51% (dorm-40min) / 63% (dorm-9pm) of the
 * time. But "I'm Boris. / Where are you from? / I'm from Poland" is unresolvable
 * in 0.68 s of audio and obvious as text: a question and its answer are
 * different speakers, which is a fact about conversation rather than about this
 * room.
 *
 * This measures that claim before anything is built on it. The model sees a
 * window of consecutive words with NO speaker labels, no timings and no counts,
 * and marks where a new person starts speaking. Nothing tells it how many
 * boundaries to find, so it can be wrong in both directions, which is the
 * point: a false split scatters one person across many voices and breaks
 * identity as badly as a merge does.
 *
 *   npx tsx eval/real/text_boundaries.mts dorm-9pm eval/real/dorm-9pm.reference.json
 *
 * Scored in word gaps, not milliseconds, because that is the unit the join
 * works in. The audio baseline is scored the same way from the same reference,
 * so the two numbers are comparable.
 */

import { readFileSync } from 'node:fs'
import { readRealFixture } from '../../fixtures/real-audio'
import type { SpeakerTurn } from '../../server/audio/diarize-sidecar'
import { extractStructured } from '../../server/memory/llm'
import { joinWordsToSpeakers } from '../../server/audio/word-join'
import { readTimedTranscript, type WhisperResponse } from '../../server/audio/whisper-client'

const stem = process.argv[2] ?? 'dorm-9pm'
const referencePath = process.argv[3]
const WINDOW = Number(process.env.WINDOW ?? 60)
const STRIDE = Number(process.env.STRIDE ?? 40)
const TOLERANCE = Number(process.env.TOLERANCE ?? 1)

interface Span { speaker: string; start_ms: number; end_ms: number }

const transcript = readTimedTranscript(readRealFixture<WhisperResponse>(`${stem}.whisper.json`))
const turns = readRealFixture<{ turns: SpeakerTurn[] }>(`${stem}.pyannote.json`).turns
const words = [...transcript.words].sort((a, b) => a.start_ms - b.start_ms)
const spans = referencePath
  ? (JSON.parse(readFileSync(referencePath, 'utf8')).spans as Span[]).sort((a, b) => a.start_ms - b.start_ms)
  : []

const truthOf = (index: number): string | null => {
  const at = (words[index].start_ms + words[index].end_ms) / 2
  return spans.find((span) => span.start_ms <= at && at < span.end_ms)?.speaker ?? null
}
const truth = words.map((_, index) => truthOf(index))

/** Gaps where the reference says a different person starts, and both sides are labelled. */
const judgeable: number[] = []
const referenceChanges = new Set<number>()
for (let index = 1; index < words.length; index += 1) {
  if (truth[index - 1] === null || truth[index] === null) continue
  judgeable.push(index)
  if (truth[index - 1] !== truth[index]) referenceChanges.add(index)
}

function score(proposed: Set<number>, name: string) {
  const considered = judgeable.filter((index) => index >= 1)
  const near = (index: number, set: Set<number>) => {
    for (let d = -TOLERANCE; d <= TOLERANCE; d += 1) if (set.has(index + d)) return true
    return false
  }
  const found = [...referenceChanges].filter((index) => near(index, proposed)).length
  const proposedHere = considered.filter((index) => proposed.has(index))
  const correct = proposedHere.filter((index) => near(index, referenceChanges)).length
  const recall = found / Math.max(referenceChanges.size, 1)
  const precision = correct / Math.max(proposedHere.length, 1)
  console.log(
    `  ${name.padEnd(22)} proposed ${String(proposedHere.length).padStart(4)}  ` +
    `recall ${(100 * recall).toFixed(0).padStart(3)}%  precision ${(100 * precision).toFixed(0).padStart(3)}%  ` +
    `F1 ${(200 * recall * precision / Math.max(recall + precision, 1e-9)).toFixed(0)}%`,
  )
  return { recall, precision }
}

// The audio's own answer, in the same unit: the join changes its mind here.
const joined = joinWordsToSpeakers(words, turns, { segments: transcript.segments })
const perWord = new Map<string, string | null>()
for (const line of joined) for (const word of line.words) perWord.set(`${word.start_ms}:${word.end_ms}`, line.speaker)
const audioChanges = new Set<number>()
for (let index = 1; index < words.length; index += 1) {
  const before = perWord.get(`${words[index - 1].start_ms}:${words[index - 1].end_ms}`) ?? null
  const after = perWord.get(`${words[index].start_ms}:${words[index].end_ms}`) ?? null
  if (before !== after) audioChanges.add(index)
}

const SYSTEM = `You segment a conversation transcript by speaker.

You are given consecutive words from one recording of several people talking, numbered from 0. There are no speaker labels and no punctuation you can trust. Decide where one person stops speaking and a different person starts.

Return the index of the FIRST word of each new speaker's stretch. Do not return 0. Judge it on what the words mean as a conversation: a question and its answer are different people, an answer to a greeting is a different person from the greeter, somebody naming themselves is not the person who asked, somebody being addressed by name is not the person speaking. Where the words read as one person continuing, return nothing for that stretch.

You are not told how many speakers or how many changes there are. Returning too many is as wrong as returning too few.`

const proposed = new Set<number>()
let calls = 0
let failed = 0

const windows: { start: number; numbered: string; length: number }[] = []
for (let start = 0; start < words.length; start += STRIDE) {
  const slice = words.slice(start, start + WINDOW)
  if (slice.length < 8) break
  windows.push({
    start,
    numbered: slice.map((word, offset) => `${offset}\t${word.text.trim()}`).join('\n'),
    length: slice.length,
  })
}

// Concurrent, because the windows are independent and a 48-minute transcript is
// two hundred of them; sequential took longer than the measurement was worth.
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 8)
let next = 0
async function worker() {
  for (;;) {
    const index = next
    next += 1
    if (index >= windows.length) return
    const window = windows[index]
    const reply = await extractStructured<{ boundaries: number[] }>({
      system: SYSTEM,
      user: window.numbered,
      schema: {
        type: 'object',
        properties: { boundaries: { type: 'array', items: { type: 'integer' } } },
        required: ['boundaries'],
      },
      maxTokens: 8_000,
      // A window the model thinks about for too long is a window with no
      // answer, not a reason to abandon the sweep. Counted rather than hidden:
      // a run that silently skipped a tenth of the transcript would report a
      // recall about a transcript nobody measured.
      salvageTruncated: () => ({ boundaries: [] as number[] }),
    }).catch(() => {
      failed += 1
      return { boundaries: [] as number[] }
    })
    calls += 1
    if (calls % 25 === 0) console.log(`  ${calls}/${windows.length} windows`)
    for (const offset of reply.boundaries ?? []) {
      if (offset > 0 && offset < window.length) proposed.add(window.start + offset)
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker))

console.log(`\n${stem}: ${words.length} words, ${judgeable.length} judgeable gaps, ${referenceChanges.size} reference speaker changes`)
console.log(`  ${calls} model calls (${failed} gave nothing), window ${WINDOW} stride ${STRIDE}, tolerance ${TOLERANCE} word`)
score(audioChanges, 'audio (pyannote join)')
score(proposed, 'text (model)')
score(new Set([...audioChanges].filter((index) => proposed.has(index))), 'both agree')
score(new Set([...audioChanges, ...proposed]), 'either')
