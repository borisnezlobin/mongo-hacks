/**
 * Is abstention against pooled voices a better trade than a turn-length floor?
 *
 * The floor measured in `abstain_cost.mts` removed about 2.7 right names for
 * every wrong one, which is why it was not worth shipping. The question here is
 * whether the same idea, aimed at "this fragment matches no voice cleanly"
 * rather than at "this turn is short", pays for itself. Same yardstick, same
 * accounting: every word scored against the reference, and the words that go
 * dark split into the ones that had been right and the ones that had been wrong.
 *
 *   npx tsx eval/real/bootstrap_cost.mts dorm-40min 6000 0 0.65 0.9 0.08
 *
 * Also prints the margin for a named turn, so "abstained because it holds two
 * people" and "abstained because the audio is poor" can be told apart.
 */

import { readFileSync } from 'node:fs'
import { readRealFixture } from '../../fixtures/real-audio'
import type { SpeakerTurn } from '../../server/audio/diarize-sidecar'
import { joinWordsToSpeakers } from '../../server/audio/word-join'
import { readTimedTranscript, type WhisperResponse } from '../../server/audio/whisper-client'

interface TurnRow { start_ms: number; end_ms: number; speaker: string; exclusive_ms: number; vector: number[] | null }
interface Span { speaker: string; start_ms: number; end_ms: number }

const [stem, seedMsArg, purityArg, joinArg, assignArg, marginArg] = process.argv.slice(2)
const seedMs = Number(seedMsArg); const purity = Number(purityArg); const join = Number(joinArg)
const assign = Number(assignArg); const margin = Number(marginArg)

const rows = (JSON.parse(readFileSync(`eval/real/${stem}.turnemb.json`, 'utf8')) as { turns: TurnRow[] }).turns
const spans = (JSON.parse(readFileSync(`eval/real/${stem}.reference.json`, 'utf8')).spans as Span[])
const transcript = readTimedTranscript(readRealFixture<WhisperResponse>(`${stem}.whisper.json`))
const shipped = readRealFixture<{ turns: SpeakerTurn[] }>(`${stem}.pyannote.json`).turns

const dot = (a: number[], b: number[]) => { let t = 0; for (let i = 0; i < a.length; i += 1) t += a[i] * b[i]; return t }
const unit = (v: number[]) => { const n = Math.sqrt(dot(v, v)) || 1; return v.map((x) => x / n) }

const seeds = rows.map((_, i) => i).filter((i) => {
  const row = rows[i]
  return !!row.vector && row.exclusive_ms >= seedMs && row.exclusive_ms / Math.max(row.end_ms - row.start_ms, 1) >= purity
})
const vectors = seeds.map((i) => rows[i].vector!)
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
  weight[best.a] += weight[best.b]; alive.delete(best.b)
}
const seen = new Map<number, number>()
const labelOfSeed = seeds.map((_, i) => { const root = find(i); if (!seen.has(root)) seen.set(root, seen.size); return seen.get(root)! })
const sums = Array.from({ length: seen.size }, () => new Array<number>(vectors[0].length).fill(0))
seeds.forEach((turn, position) => {
  const w = rows[turn].exclusive_ms
  for (let i = 0; i < vectors[0].length; i += 1) sums[labelOfSeed[position]][i] += rows[turn].vector![i] * w
})
const centroids = sums.map(unit)

function score(index: number) {
  const row = rows[index]
  if (!row.vector) return null
  const similarities = centroids.map((c) => dot(row.vector!, c)).sort((a, b) => b - a)
  return { best: similarities[0], runnerUp: similarities[1] ?? -1, gap: similarities[0] - (similarities[1] ?? -1) }
}

const turns: SpeakerTurn[] = rows.map((row, index) => {
  const s = score(index)
  const ok = s !== null && 1 - s.best <= assign && (centroids.length < 2 || s.gap >= margin)
  let winner = -1
  if (ok) {
    let best = -Infinity
    for (const [i, c] of centroids.entries()) { const v = dot(row.vector!, c); if (v > best) { best = v; winner = i } }
  }
  return { speaker: ok ? `VOICE_${String(winner).padStart(2, '0')}` : `UNKNOWN_${index}`, start_ms: row.start_ms, end_ms: row.end_ms }
})

const truthOf = (start: number, end: number) => {
  const at = (start + end) / 2
  return spans.find((s) => s.start_ms <= at && at < s.end_ms)?.speaker ?? null
}

function words(all: SpeakerTurn[]) {
  const lines = joinWordsToSpeakers(transcript.words, all, { segments: transcript.segments })
  const per = new Map<string, string | null>()
  for (const line of lines) {
    const speaker = line.speaker && !line.speaker.startsWith('UNKNOWN_') ? line.speaker : null
    for (const word of line.words) per.set(`${word.start_ms}:${word.end_ms}`, speaker)
  }
  return per
}
function mapping(all: SpeakerTurn[]) {
  const tally = new Map<string, Map<string, number>>()
  for (const turn of all) {
    if (turn.speaker.startsWith('UNKNOWN_')) continue
    for (const span of spans) {
      const shared = Math.min(turn.end_ms, span.end_ms) - Math.max(turn.start_ms, span.start_ms)
      if (shared <= 0) continue
      const per = tally.get(turn.speaker) ?? new Map<string, number>()
      per.set(span.speaker, (per.get(span.speaker) ?? 0) + shared)
      tally.set(turn.speaker, per)
    }
  }
  const out = new Map<string, string>()
  for (const [label, per] of tally) { let b = 0; let w = ''; for (const [p, ms] of per) if (ms > b) { b = ms; w = p }; out.set(label, w) }
  return out
}

const judged = transcript.words.filter((word) => truthOf(word.start_ms, word.end_ms) !== null)
const results: Record<string, ('right' | 'wrong' | null)[]> = {}
for (const [name, all] of [['shipped', shipped], ['bootstrap', turns]] as const) {
  const per = words(all)
  const map = mapping(all)
  results[name] = judged.map((word) => {
    const said = per.get(`${word.start_ms}:${word.end_ms}`) ?? null
    if (!said) return null
    return map.get(said) === truthOf(word.start_ms, word.end_ms) ? 'right' : 'wrong'
  })
}
const count = (name: string, value: 'right' | 'wrong' | null) => results[name].filter((v) => v === value).length
console.log(`${stem}  seed ${seedMs} purity ${purity} join ${join} assign ${assign} margin ${margin}  -> ${centroids.length} voices`)
console.log(`  ${judged.length} words the reference speaks to`)
for (const name of ['shipped', 'bootstrap']) {
  const right = count(name, 'right'); const wrong = count(name, 'wrong'); const dark = count(name, null)
  console.log(`  ${name.padEnd(10)} named ${(100 * (right + wrong) / judged.length).toFixed(1)}%  right ${right}  wrong ${wrong}  unattributed ${dark}  precision ${(100 * right / Math.max(right + wrong, 1)).toFixed(1)}%`)
}
const rightLost = results.bootstrap.filter((v, i) => v === null && results.shipped[i] === 'right').length
const wrongLost = results.bootstrap.filter((v, i) => v === null && results.shipped[i] === 'wrong').length
const fixed = results.bootstrap.filter((v, i) => v === 'right' && results.shipped[i] === 'wrong').length
const broken = results.bootstrap.filter((v, i) => v === 'wrong' && results.shipped[i] === 'right').length
console.log(`  against shipped: ${rightLost} right names withheld, ${wrongLost} wrong names withheld ` +
  `(${(rightLost / Math.max(wrongLost, 1)).toFixed(2)} right per wrong), ${fixed} corrected, ${broken} newly wrong`)

const probe = Number(process.env.PROBE_MS ?? 0)
if (probe) {
  console.log('\n  margin against the pooled voices, for turns around the probe:')
  rows.forEach((row, index) => {
    if (row.end_ms < probe - 12_000 || row.start_ms > probe + 12_000) return
    const s = score(index)
    const length = (row.end_ms - row.start_ms) / 1000
    if (!s) { console.log(`    ${(row.start_ms / 1000).toFixed(2)}-${(row.end_ms / 1000).toFixed(2)}s (${length.toFixed(2)}s) no clean speech`); return }
    console.log(`    ${(row.start_ms / 1000).toFixed(2)}-${(row.end_ms / 1000).toFixed(2)}s  clean ${(row.exclusive_ms / 1000).toFixed(2)}s  ` +
      `best ${s.best.toFixed(3)}  runner-up ${s.runnerUp.toFixed(3)}  gap ${s.gap.toFixed(3)}  ${s.gap >= margin && 1 - s.best <= assign ? 'named' : 'ABSTAINED'}`)
  })
}
