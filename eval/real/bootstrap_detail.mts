/**
 * One bootstrap configuration, spelled out landmark by landmark.
 *
 * A merge that disappears because the pipeline stopped answering is not the
 * same as a merge that disappears because the two people were told apart, and
 * the counts in the sweep cannot tell them apart. This prints the verdict for
 * every landmark constraint, so "fixed" and "silenced" are visibly different.
 *
 *   npx tsx eval/real/bootstrap_detail.mts dorm-40min 6000 0 0.65 0.9 0.08
 */

import { readFileSync, existsSync } from 'node:fs'
import { checkLandmarks, LANDMARKS } from '../landmarks'
import { readRealFixture } from '../../fixtures/real-audio'
import type { SpeakerTurn } from '../../server/audio/diarize-sidecar'
import { joinWordsToSpeakers } from '../../server/audio/word-join'
import { readTimedTranscript, type WhisperResponse } from '../../server/audio/whisper-client'
import type { AttributedSegment } from '../scoring'

interface TurnRow { start_ms: number; end_ms: number; speaker: string; exclusive_ms: number; vector: number[] | null }

const [stem, seedMsArg, purityArg, joinArg, assignArg, marginArg] = process.argv.slice(2)
const seedMs = Number(seedMsArg)
const purity = Number(purityArg)
const join = Number(joinArg)
const assign = Number(assignArg)
const margin = Number(marginArg)
const recording = stem as 'dorm-9pm' | 'dorm-40min'

const rows = (JSON.parse(readFileSync(`eval/real/${stem}.turnemb.json`, 'utf8')) as { turns: TurnRow[] }).turns
const transcript = readTimedTranscript(readRealFixture<WhisperResponse>(`${stem}.whisper.json`))
const shipped = readRealFixture<{ turns: SpeakerTurn[] }>(`${stem}.pyannote.json`).turns

const dot = (a: number[], b: number[]) => { let t = 0; for (let i = 0; i < a.length; i += 1) t += a[i] * b[i]; return t }
const unit = (v: number[]) => { const n = Math.sqrt(dot(v, v)) || 1; return v.map((x) => x / n) }

const seeds = rows.map((_, index) => index).filter((index) => {
  const row = rows[index]
  return !!row.vector && row.exclusive_ms >= seedMs &&
    row.exclusive_ms / Math.max(row.end_ms - row.start_ms, 1) >= purity
})
const vectors = seeds.map((index) => rows[index].vector!)
const size = vectors.length
const distance: number[][] = Array.from({ length: size }, () => new Array<number>(size).fill(0))
for (let i = 0; i < size; i += 1) for (let j = i + 1; j < size; j += 1) distance[i][j] = distance[j][i] = 1 - dot(vectors[i], vectors[j])
const weight = new Array<number>(size).fill(1)
const alive = new Set(Array.from({ length: size }, (_, i) => i))
const parent = Array.from({ length: size }, (_, i) => i)
const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
while (alive.size > 1) {
  let best: { a: number; b: number; d: number } | null = null
  for (const a of alive) for (const b of alive) { if (b <= a) continue; const d = distance[a][b]; if (!best || d < best.d) best = { a, b, d } }
  if (!best || best.d > join) break
  parent[find(best.b)] = find(best.a)
  for (const other of alive) {
    if (other === best.a || other === best.b) continue
    distance[best.a][other] = distance[other][best.a] =
      (weight[best.a] * distance[best.a][other] + weight[best.b] * distance[best.b][other]) / (weight[best.a] + weight[best.b])
  }
  weight[best.a] += weight[best.b]
  alive.delete(best.b)
}
const labelOfSeed = new Map<number, number>()
const seen = new Map<number, number>()
for (let i = 0; i < size; i += 1) {
  const root = find(i)
  if (!seen.has(root)) seen.set(root, seen.size)
  labelOfSeed.set(i, seen.get(root)!)
}
const count = seen.size
const sums = Array.from({ length: count }, () => new Array<number>(vectors[0].length).fill(0))
seeds.forEach((turn, position) => {
  const label = labelOfSeed.get(position)!
  const w = rows[turn].exclusive_ms
  for (let i = 0; i < vectors[0].length; i += 1) sums[label][i] += rows[turn].vector![i] * w
})
const centroids = sums.map(unit)

const turns: SpeakerTurn[] = rows.map((row, index) => {
  if (!row.vector) return { speaker: `UNKNOWN_${index}`, start_ms: row.start_ms, end_ms: row.end_ms }
  let best = -Infinity; let runnerUp = -Infinity; let winner = -1
  for (const [i, centroid] of centroids.entries()) {
    const s = dot(row.vector, centroid)
    if (s > best) { runnerUp = best; best = s; winner = i } else if (s > runnerUp) runnerUp = s
  }
  const ok = winner >= 0 && 1 - best <= assign && (centroids.length < 2 || best - runnerUp >= margin)
  return {
    speaker: ok ? `VOICE_${String(winner).padStart(2, '0')}` : `UNKNOWN_${index}`,
    start_ms: row.start_ms,
    end_ms: row.end_ms,
  }
})

const toSegments = (all: SpeakerTurn[]) => {
  const lines = joinWordsToSpeakers(transcript.words, all, { segments: transcript.segments })
  return lines
    .filter((line) => line.speaker && !line.speaker.startsWith('UNKNOWN_'))
    .map((line): AttributedSegment => ({
      speaker: line.speaker as string, text: line.text,
      start_ms: line.start_ms, end_ms: line.end_ms,
    }))
}

console.log(`${stem}  seed ${seedMs} purity ${purity} join ${join} assign ${assign} margin ${margin}`)
console.log(`  ${seeds.length} seeds -> ${count} voices`)
for (const [name, segments] of [['shipped', toSegments(shipped)], ['bootstrap', toSegments(turns)]] as const) {
  const report = checkLandmarks(recording, segments)
  console.log(`\n  ${name}: ${report.merges.length} merges, ${report.splits.length} splits, ${report.total - report.covered} unresolved of ${report.total}`)
  for (const landmark of LANDMARKS.filter((l) => l.recording === recording)) {
    const hit = segments.find((s) => s.end_ms > landmark.at_ms && s.start_ms < landmark.end_ms)
    console.log(`    ${(landmark.at_ms / 1000).toFixed(2).padStart(8)}s ${JSON.stringify(landmark.quote.slice(0, 26)).padEnd(30)} -> ${hit?.speaker ?? 'UNATTRIBUTED'}`)
  }
  for (const pair of report.merges) console.log(`    MERGE  "${pair.a.quote.slice(0, 24)}" / "${pair.b.quote.slice(0, 24)}"`)
  for (const pair of report.splits) console.log(`    SPLIT  "${pair.a.quote.slice(0, 24)}" / "${pair.b.quote.slice(0, 24)}"`)
}
