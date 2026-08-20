/**
 * Cluster the long clean stretches first, then assign the fragments to them.
 *
 * pyannote clusters every (window, local speaker) embedding at once, so a
 * fragment with half a second of speech in it votes on the shape of the
 * clusters and then gets a label off its own unreliable vector. Measured
 * against the reference, a turn under half a second carries the right label 44%
 * of the time on dorm-40min and 13% on dorm-9pm.
 *
 * This does it in two passes instead, which is how a person in the room does
 * it: learn the voices from the stretches where somebody talks uninterrupted,
 * pool those into one vector per voice, and then match each fragment against
 * the voices rather than against other fragments. `pooled_floor.py` measured
 * the difference that asymmetry makes -- at one second, 81% closed-set accuracy
 * against a 58% majority baseline, where the fragment-to-fragment question is
 * near chance.
 *
 *   python eval/real/turn_embeddings.py dorm-40min
 *   npx tsx eval/real/bootstrap_sweep.mts dorm-40min
 *
 * Nothing here is told how many people are in the room, and the seeds are
 * chosen by properties the product can see -- clean-speech duration and how
 * much of the turn the segmentation heard nobody else in. No reference labels
 * enter the pipeline; they are used only to score it afterwards.
 */

import { readFileSync, existsSync } from 'node:fs'
import { checkLandmarks } from '../landmarks'
import { hasRealFixture, readRealFixture } from '../../fixtures/real-audio'
import type { SpeakerTurn } from '../../server/audio/diarize-sidecar'
import { joinWordsToSpeakers } from '../../server/audio/word-join'
import { readTimedTranscript, type WhisperResponse } from '../../server/audio/whisper-client'
import type { AttributedSegment } from '../scoring'

interface TurnRow {
  start_ms: number
  end_ms: number
  speaker: string
  exclusive_ms: number
  vector: number[] | null
}
interface Span { speaker: string; start_ms: number; end_ms: number }

const stem = process.argv[2] ?? 'dorm-40min'
const recording = (stem === 'dorm-9pm' || stem === 'dorm-40min') ? stem : null
const unlocatable = stem === 'dorm-40min' ? ['Goodnight.'] : []

const embeddingPath = `eval/real/${stem}.turnemb.json`
const referencePath = `eval/real/${stem}.reference.json`
const rows = (JSON.parse(readFileSync(embeddingPath, 'utf8')) as { turns: TurnRow[] }).turns
const spans: Span[] = existsSync(referencePath)
  ? (JSON.parse(readFileSync(referencePath, 'utf8')).spans as Span[])
  : []
const transcript = readTimedTranscript(readRealFixture<WhisperResponse>(`${stem}.whisper.json`))
const shipped = readRealFixture<{ turns: SpeakerTurn[] }>(`${stem}.pyannote.json`).turns

const dot = (a: number[], b: number[]) => {
  let total = 0
  for (let i = 0; i < a.length; i += 1) total += a[i] * b[i]
  return total
}
const unit = (v: number[]) => {
  const n = Math.sqrt(dot(v, v)) || 1
  return v.map((x) => x / n)
}

/**
 * Average-linkage agglomerative clustering, built once and cut many times.
 *
 * The dendrogram does not depend on where it is cut, so the sweep builds it
 * once per seed set and reads every join threshold off the same merge sequence.
 * Distances are maintained by the Lance-Williams update rather than recomputed
 * from members, which is what turns an afternoon into a second.
 *
 * A threshold rather than a cluster count, deliberately: a count would be the
 * answer smuggled in, and nothing in the product knows how many people are in
 * the room.
 */
interface Dendrogram { merges: { a: number; b: number; d: number }[]; size: number }

function buildDendrogram(vectors: number[][]): Dendrogram {
  const size = vectors.length
  const distance: number[][] = Array.from({ length: size }, () => new Array<number>(size).fill(0))
  for (let i = 0; i < size; i += 1) {
    for (let j = i + 1; j < size; j += 1) {
      distance[i][j] = distance[j][i] = 1 - dot(vectors[i], vectors[j])
    }
  }
  const weight = new Array<number>(size).fill(1)
  const alive = new Set(Array.from({ length: size }, (_, index) => index))
  const merges: { a: number; b: number; d: number }[] = []
  while (alive.size > 1) {
    let best: { a: number; b: number; d: number } | null = null
    for (const a of alive) {
      for (const b of alive) {
        if (b <= a) continue
        const d = distance[a][b]
        if (!best || d < best.d) best = { a, b, d }
      }
    }
    if (!best) break
    merges.push(best)
    const { a, b } = best
    for (const other of alive) {
      if (other === a || other === b) continue
      distance[a][other] = distance[other][a] =
        (weight[a] * distance[a][other] + weight[b] * distance[b][other]) / (weight[a] + weight[b])
    }
    weight[a] += weight[b]
    alive.delete(b)
  }
  return { merges, size }
}

function cut(tree: Dendrogram, threshold: number): number[] {
  const parent = Array.from({ length: tree.size }, (_, index) => index)
  const find = (index: number): number => (parent[index] === index ? index : (parent[index] = find(parent[index])))
  for (const merge of tree.merges) {
    if (merge.d > threshold) break
    parent[find(merge.b)] = find(merge.a)
  }
  const label = new Array<number>(tree.size).fill(-1)
  const seen = new Map<number, number>()
  for (let index = 0; index < tree.size; index += 1) {
    const root = find(index)
    if (!seen.has(root)) seen.set(root, seen.size)
    label[index] = seen.get(root)!
  }
  return label
}

function centroidsFrom(seeds: number[], labels: number[], count: number): number[][] {
  const sums = Array.from({ length: count }, () => new Array<number>(rows[seeds[0]].vector!.length).fill(0))
  const weights = new Array<number>(count).fill(0)
  seeds.forEach((turn, position) => {
    const label = labels[position]
    if (label < 0) return
    // Weighted by clean speech: a twelve-second stretch is better evidence about
    // a voice than a two-second one, and an unweighted mean lets the short ones
    // outvote it.
    const weight = rows[turn].exclusive_ms
    const vector = rows[turn].vector!
    for (let i = 0; i < vector.length; i += 1) sums[label][i] += vector[i] * weight
    weights[label] += weight
  })
  return sums.map(unit)
}

const truthOf = (start: number, end: number): string | null => {
  const at = (start + end) / 2
  return spans.find((span) => span.start_ms <= at && at < span.end_ms)?.speaker ?? null
}

/**
 * B-cubed against the reference, weighted by milliseconds.
 *
 * Accuracy after mapping each voice to its majority person rewards splitting: a
 * pipeline that gives every turn its own label scores 100%. B-cubed does not.
 * Precision falls when one voice holds two people, recall falls when one person
 * is spread over two voices, and the harmonic mean of the two is the number
 * that cannot be gamed in either direction -- which is the whole failure mode
 * the landmark set exists to catch, expressed as a rate.
 */
function bCubed(contingency: Map<string, Map<string, number>>): { precision: number; recall: number; f1: number } {
  let total = 0
  const perPerson = new Map<string, number>()
  for (const per of contingency.values()) {
    for (const [person, ms] of per) {
      total += ms
      perPerson.set(person, (perPerson.get(person) ?? 0) + ms)
    }
  }
  if (total === 0) return { precision: 0, recall: 0, f1: 0 }
  let precision = 0
  let recall = 0
  for (const per of contingency.values()) {
    const inLabel = [...per.values()].reduce((a, b) => a + b, 0)
    for (const [person, ms] of per) {
      precision += (ms * ms) / inLabel
      recall += (ms * ms) / (perPerson.get(person) ?? 1)
    }
  }
  precision /= total
  recall /= total
  return { precision, recall, f1: (2 * precision * recall) / Math.max(precision + recall, 1e-9) }
}

interface Result {
  seedMs: number
  purity: number
  join: number
  assign: number
  margin: number
  voices: number
  seeds: number
  merges: number
  splits: number
  unresolved: number
  namedWords: number
  accuracy: number
  judged: number
  f1: number
  byLength: Map<string, [number, number]>
}

function seedsFor(seedMs: number, purity: number): number[] {
  return rows
    .map((_, index) => index)
    .filter((index) => {
      const row = rows[index]
      if (!row.vector) return false
      if (row.exclusive_ms < seedMs) return false
      return row.exclusive_ms / Math.max(row.end_ms - row.start_ms, 1) >= purity
    })
}

function run(
  seeds: number[], tree: Dendrogram,
  seedMs: number, purity: number, join: number, assign: number, margin: number,
): Result | null {
  if (seeds.length < 2) return null
  const labels = cut(tree, join)
  const count = Math.max(...labels) + 1
  const centroids = centroidsFrom(seeds, labels, count)

  const assigned: (string | null)[] = rows.map((row) => {
    if (!row.vector) return null
    let best = -Infinity
    let runnerUp = -Infinity
    let winner = -1
    for (const [index, centroid] of centroids.entries()) {
      const similarity = dot(row.vector, centroid)
      if (similarity > best) { runnerUp = best; best = similarity; winner = index }
      else if (similarity > runnerUp) runnerUp = similarity
    }
    if (winner < 0) return null
    if (1 - best > assign) return null
    if (centroids.length > 1 && best - runnerUp < margin) return null
    return `VOICE_${String(winner).padStart(2, '0')}`
  })

  // An unattributed turn keeps a label of its own so it still blocks the snap:
  // the word was heard, and handing it to a neighbour is the error being
  // avoided. These are stripped again before anything is scored.
  const turns: SpeakerTurn[] = rows.map((row, index) => ({
    speaker: assigned[index] ?? `UNKNOWN_${index}`,
    start_ms: row.start_ms,
    end_ms: row.end_ms,
  }))

  const lines = joinWordsToSpeakers(transcript.words, turns, { segments: transcript.segments })
  const named = lines.filter((line) => line.speaker && !line.speaker.startsWith('UNKNOWN_'))
  const namedWords = named.reduce((total, line) => total + line.words.length, 0)

  let merges = 0
  let splits = 0
  let unresolved = 0
  if (recording) {
    const segments: AttributedSegment[] = named.map((line) => ({
      speaker: line.speaker as string,
      text: line.text,
      start_ms: line.start_ms,
      end_ms: line.end_ms,
    }))
    const report = checkLandmarks(recording, segments)
    const locatable = (pair: { a: { quote: string }; b: { quote: string } }) =>
      !unlocatable.includes(pair.a.quote) && !unlocatable.includes(pair.b.quote)
    merges = report.merges.filter(locatable).length
    splits = report.splits.filter(locatable).length
    unresolved = report.total - report.covered
  }

  // Turn-label accuracy against the reference, under the most generous mapping
  // of voice to person available, so any error left is one no relabelling fixes.
  const tally = new Map<string, Map<string, number>>()
  for (const [index, row] of rows.entries()) {
    const label = assigned[index]
    if (!label) continue
    for (const span of spans) {
      const shared = Math.min(row.end_ms, span.end_ms) - Math.max(row.start_ms, span.start_ms)
      if (shared <= 0) continue
      const per = tally.get(label) ?? new Map<string, number>()
      per.set(span.speaker, (per.get(span.speaker) ?? 0) + shared)
      tally.set(label, per)
    }
  }
  const personOf = new Map<string, string>()
  for (const [label, per] of tally) {
    let best = 0
    let who = ''
    for (const [person, ms] of per) if (ms > best) { best = ms; who = person }
    personOf.set(label, who)
  }

  const buckets: [string, number, number][] = [
    ['<0.5', 0, 500], ['0.5-1', 500, 1_000], ['1-2', 1_000, 2_000], ['2-4', 2_000, 4_000], ['>4', 4_000, Infinity],
  ]
  const byLength = new Map<string, [number, number]>()
  let right = 0
  let judged = 0
  for (const [index, row] of rows.entries()) {
    const label = assigned[index]
    if (!label) continue
    const truth = truthOf(row.start_ms, row.end_ms)
    if (!truth) continue
    judged += 1
    const ok = personOf.get(label) === truth
    if (ok) right += 1
    const length = row.end_ms - row.start_ms
    const bucket = buckets.find(([, lo, hi]) => length >= lo && length < hi)![0]
    const current = byLength.get(bucket) ?? [0, 0]
    byLength.set(bucket, [current[0] + (ok ? 1 : 0), current[1] + 1])
  }

  const scores = bCubed(tally)

  return {
    seedMs, purity, join, assign, margin,
    f1: scores.f1,
    voices: centroids.length,
    seeds: seeds.length,
    merges, splits, unresolved,
    namedWords: namedWords / transcript.words.length,
    accuracy: judged ? right / judged : 0,
    judged,
    byLength,
  }
}

// The shipped pipeline, scored the same way, as the line every row must beat.
function baseline() {
  const lines = joinWordsToSpeakers(transcript.words, shipped, { segments: transcript.segments })
  const named = lines.filter((line) => line.speaker)
  const namedWords = named.reduce((total, line) => total + line.words.length, 0)
  let merges = 0
  let splits = 0
  let unresolved = 0
  if (recording) {
    const segments: AttributedSegment[] = named.map((line) => ({
      speaker: line.speaker as string, text: line.text,
      start_ms: line.start_ms, end_ms: line.end_ms,
    }))
    const report = checkLandmarks(recording, segments)
    const locatable = (pair: { a: { quote: string }; b: { quote: string } }) =>
      !unlocatable.includes(pair.a.quote) && !unlocatable.includes(pair.b.quote)
    merges = report.merges.filter(locatable).length
    splits = report.splits.filter(locatable).length
    unresolved = report.total - report.covered
  }
  const tally = new Map<string, Map<string, number>>()
  for (const turn of shipped) {
    for (const span of spans) {
      const shared = Math.min(turn.end_ms, span.end_ms) - Math.max(turn.start_ms, span.start_ms)
      if (shared <= 0) continue
      const per = tally.get(turn.speaker) ?? new Map<string, number>()
      per.set(span.speaker, (per.get(span.speaker) ?? 0) + shared)
      tally.set(turn.speaker, per)
    }
  }
  const personOf = new Map<string, string>()
  for (const [label, per] of tally) {
    let best = 0; let who = ''
    for (const [person, ms] of per) if (ms > best) { best = ms; who = person }
    personOf.set(label, who)
  }
  let right = 0; let judged = 0
  for (const turn of shipped) {
    const truth = truthOf(turn.start_ms, turn.end_ms)
    if (!truth) continue
    judged += 1
    if (personOf.get(turn.speaker) === truth) right += 1
  }
  return {
    f1: bCubed(tally).f1,
    voices: new Set(shipped.map((turn) => turn.speaker)).size,
    merges, splits, unresolved,
    namedWords: namedWords / transcript.words.length,
    accuracy: judged ? right / judged : 0,
    judged,
  }
}

const base = baseline()
console.log(`\n${stem}: ${rows.length} turns, ${rows.filter((row) => row.vector).length} embeddable, ${spans.length} reference spans`)
console.log(`  shipped pyannote clustering: ${base.voices} voices  merges ${base.merges}  splits ${base.splits}  ` +
  `unresolved ${base.unresolved}  words named ${(100 * base.namedWords).toFixed(1)}%  turn accuracy ${(100 * base.accuracy).toFixed(1)}% of ${base.judged}  B3 F1 ${(100 * base.f1).toFixed(1)}%`)
console.log('\n  seed  purity  join  assign  margin | voices  seeds |  merges splits unres | words named | turn acc | B3 F1')

const JOINS = [0.4, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8]
const results: Result[] = []
for (const seedMs of [1_500, 2_000, 3_000, 4_000, 6_000]) {
  for (const purity of [0.0, 0.6, 0.9]) {
    const seeds = seedsFor(seedMs, purity)
    if (seeds.length < 2) continue
    const tree = buildDendrogram(seeds.map((index) => rows[index].vector!))
    for (const join of JOINS) {
      for (const assign of [0.9, 1.0]) {
        for (const margin of [0.0, 0.03, 0.08]) {
          const result = run(seeds, tree, seedMs, purity, join, assign, margin)
          if (!result) continue
          results.push(result)
          console.log(
            `  ${String(seedMs).padStart(4)}  ${purity.toFixed(1).padStart(6)}  ${join.toFixed(2)}  ` +
            `${assign.toFixed(2).padStart(6)}  ${margin.toFixed(2).padStart(6)} | ` +
            `${String(result.voices).padStart(6)}  ${String(result.seeds).padStart(5)} | ` +
            `${String(result.merges).padStart(7)} ${String(result.splits).padStart(6)} ${String(result.unresolved).padStart(5)} | ` +
            `${(100 * result.namedWords).toFixed(1).padStart(10)}% | ${(100 * result.accuracy).toFixed(1).padStart(5)}% | ${(100 * result.f1).toFixed(1).padStart(5)}%`,
          )
        }
      }
    }
  }
}

const best = results
  .filter((result) => result.namedWords > 0.6)
  .sort((a, b) => (a.merges + a.splits) - (b.merges + b.splits) || b.f1 - a.f1)[0]
if (best) {
  console.log(`\n  best by landmark verdicts then B3 F1: seed ${best.seedMs} purity ${best.purity} join ${best.join} assign ${best.assign} margin ${best.margin}`)
  console.log('  turn accuracy by turn length:')
  for (const bucket of ['<0.5', '0.5-1', '1-2', '2-4', '>4']) {
    const cell = best.byLength.get(bucket)
    if (cell) console.log(`    ${bucket.padEnd(6)}s ${String(cell[0]).padStart(4)}/${String(cell[1]).padEnd(5)} ${(100 * cell[0] / cell[1]).toFixed(1)}%`)
  }
}
