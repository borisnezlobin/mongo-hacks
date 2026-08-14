/**
 * Measures speaker attribution accuracy, bucketed by how long the turn was.
 *
 * The old threshold was tuned by eye against a single seven-utterance fixture
 * in which every turn was longer than two seconds. That is how a pipeline that
 * cannot attribute short turns at all reached a stage demo. This harness exists
 * so no tuning decision is ever made that way again.
 *
 * It runs two pipelines over identical audio and identical enrollments:
 *
 *   baseline  what shipped — embed each turn on its own, drop anything under
 *             the 3000 ms floor, match against enrolled voiceprints
 *   clustered what replaces it — group turns into speaker clusters first, then
 *             match each cluster's pooled audio once
 *
 * Enrollment audio comes from a *different recording* of the same voices, so
 * this is a cross-session test rather than a self-match.
 *
 * Requires the ECAPA sidecar on :8099. Run:
 *   npx tsx eval/attribution.mts
 */

import { readFileSync } from 'node:fs'
import { ATTRIBUTION_THRESHOLD, EMBED_MIN_MS } from '../shared/contracts'
import { embedPcm, embedPcmForClustering } from '../server/audio/embed-client'
import { MIN_EMBED_MS, SpeakerClusterer, cosine } from '../server/audio/speaker-clusterer'
import { readWav } from '../server/audio/wav'

const SAMPLE_RATE = 16_000

interface LabelledTurn {
  utterance_id: string
  speaker: string
  text: string
  start_ms: number
  end_ms: number
}

interface Recording {
  samples: Float32Array
  turns: LabelledTurn[]
}

function load(wavPath: string, labelPath: string): Recording {
  const { samples, sampleRate } = readWav(readFileSync(wavPath))
  if (sampleRate !== SAMPLE_RATE) throw new Error(`${wavPath}: expected 16 kHz, got ${sampleRate}`)
  const labels = JSON.parse(readFileSync(labelPath, 'utf8')) as { utterances: LabelledTurn[] }
  return { samples, turns: labels.utterances }
}

function slice(recording: Recording, startMs: number, endMs: number): Float32Array {
  const from = Math.max(0, Math.floor((startMs / 1000) * SAMPLE_RATE))
  const to = Math.min(recording.samples.length, Math.ceil((endMs / 1000) * SAMPLE_RATE))
  return recording.samples.slice(from, to)
}

function concat(pieces: Float32Array[]): Float32Array {
  const merged = new Float32Array(pieces.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const piece of pieces) {
    merged.set(piece, offset)
    offset += piece.length
  }
  return merged
}

/**
 * Enroll each speaker from their pooled speech in the enrollment recording.
 * This is the retroactive-enrollment model: nobody recorded anything on
 * purpose, we just kept what they already said.
 */
async function enroll(recording: Recording, nameFor: Record<string, string>): Promise<Map<string, number[]>> {
  const bySpeaker = new Map<string, Float32Array[]>()
  for (const turn of recording.turns) {
    const canonical = nameFor[turn.speaker] ?? turn.speaker
    const pieces = bySpeaker.get(canonical) ?? []
    pieces.push(slice(recording, turn.start_ms, turn.end_ms))
    bySpeaker.set(canonical, pieces)
  }
  const prints = new Map<string, number[]>()
  for (const [speaker, pieces] of bySpeaker) {
    const { vector } = await embedPcm(concat(pieces))
    prints.set(speaker, vector)
  }
  return prints
}

function bestMatch(embedding: number[], prints: Map<string, number[]>): { speaker: string; score: number } {
  let best = { speaker: '', score: -1 }
  for (const [speaker, print] of prints) {
    const score = cosine(embedding, print)
    if (score > best.score) best = { speaker, score }
  }
  return best
}

type Verdict = 'correct' | 'wrong' | 'unattributed'

/** Embed every turn once; both pipelines reuse these. */
async function embedTurns(recording: Recording): Promise<Map<string, number[] | null>> {
  const embeddings = new Map<string, number[] | null>()
  for (const turn of recording.turns) {
    const durationMs = turn.end_ms - turn.start_ms
    if (durationMs < MIN_EMBED_MS) {
      embeddings.set(turn.utterance_id, null)
      continue
    }
    const audio = slice(recording, turn.start_ms, turn.end_ms)
    embeddings.set(turn.utterance_id, (await embedPcmForClustering(audio)).vector)
  }
  return embeddings
}

/** What shipped: each turn stands alone, and short ones never get looked at. */
function runBaseline(
  recording: Recording,
  embeddings: Map<string, number[] | null>,
  prints: Map<string, number[]>,
): Map<string, Verdict> {
  const verdicts = new Map<string, Verdict>()
  for (const turn of recording.turns) {
    const durationMs = turn.end_ms - turn.start_ms
    const embedding = embeddings.get(turn.utterance_id)
    if (durationMs < EMBED_MIN_MS || !embedding) {
      verdicts.set(turn.utterance_id, 'unattributed')
      continue
    }
    const match = bestMatch(embedding, prints)
    verdicts.set(
      turn.utterance_id,
      match.score < ATTRIBUTION_THRESHOLD
        ? 'unattributed'
        : match.speaker === turn.speaker
          ? 'correct'
          : 'wrong',
    )
  }
  return verdicts
}

/** The replacement: cluster first, then attribute each cluster's pooled audio. */
async function runClustered(
  recording: Recording,
  embeddings: Map<string, number[] | null>,
  prints: Map<string, number[]>,
): Promise<{ verdicts: Map<string, Verdict>; reasons: Map<string, string>; clusters: number }> {
  const clusterer = new SpeakerClusterer()
  const clusterOf = new Map<string, string>()
  const reasons = new Map<string, string>()
  const record = (assignments: ReturnType<SpeakerClusterer['flush']>) => {
    for (const assignment of assignments) {
      clusterOf.set(assignment.label, assignment.clusterId)
      reasons.set(assignment.label, assignment.reason)
    }
  }

  for (const turn of recording.turns) {
    record(
      clusterer.add(
        { label: turn.utterance_id, start_ms: turn.start_ms, end_ms: turn.end_ms },
        embeddings.get(turn.utterance_id) ?? null,
      ),
    )
  }
  record(clusterer.flush())

  // One match per cluster, on everything that cluster said.
  const speakerOfCluster = new Map<string, string | null>()
  for (const cluster of clusterer.all) {
    const pooled = concat(cluster.members.map((m) => slice(recording, m.start_ms, m.end_ms)))
    const durationMs = (pooled.length / SAMPLE_RATE) * 1000
    if (durationMs < EMBED_MIN_MS) {
      speakerOfCluster.set(cluster.id, null)
      continue
    }
    const { vector } = await embedPcm(pooled)
    const match = bestMatch(vector, prints)
    speakerOfCluster.set(cluster.id, match.score < ATTRIBUTION_THRESHOLD ? null : match.speaker)
  }

  const verdicts = new Map<string, Verdict>()
  for (const turn of recording.turns) {
    const clusterId = clusterOf.get(turn.utterance_id)
    const resolved = clusterId ? speakerOfCluster.get(clusterId) : null
    verdicts.set(
      turn.utterance_id,
      !resolved ? 'unattributed' : resolved === turn.speaker ? 'correct' : 'wrong',
    )
  }
  return { verdicts, reasons, clusters: clusterer.all.length }
}

const BUCKETS: Array<{ label: string; fits: (ms: number) => boolean }> = [
  { label: '< 1s', fits: (ms) => ms < 1000 },
  { label: '1-3s', fits: (ms) => ms >= 1000 && ms < 3000 },
  { label: '> 3s', fits: (ms) => ms >= 3000 },
]

function report(name: string, recording: Recording, verdicts: Map<string, Verdict>): void {
  console.log(`\n  ${name}`)
  console.log('  ' + '-'.repeat(58))
  console.log('  duration    turns   correct     wrong   unattributed')
  for (const bucket of BUCKETS) {
    const turns = recording.turns.filter((t) => bucket.fits(t.end_ms - t.start_ms))
    if (turns.length === 0) continue
    const tally = (v: Verdict) => turns.filter((t) => verdicts.get(t.utterance_id) === v).length
    const correct = tally('correct')
    console.log(
      `  ${bucket.label.padEnd(10)}${String(turns.length).padStart(5)}` +
        `${`${correct} (${Math.round((correct / turns.length) * 100)}%)`.padStart(12)}` +
        `${String(tally('wrong')).padStart(10)}${String(tally('unattributed')).padStart(15)}`,
    )
  }
  const correct = recording.turns.filter((t) => verdicts.get(t.utterance_id) === 'correct').length
  console.log(
    `  ${'all'.padEnd(10)}${String(recording.turns.length).padStart(5)}` +
      `${`${correct} (${Math.round((correct / recording.turns.length) * 100)}%)`.padStart(12)}`,
  )
}

async function main(): Promise<void> {
  // The two recordings share voices under different character names.
  const nameFor: Record<string, string> = {
    "Amelia's owner": 'Yan',
    Maya: 'Maya',
    Jules: 'Jules',
    Priya: 'Priya',
  }

  const enrollment = load('fixtures/conversation.wav', 'fixtures/transcript.json')
  const test = load('eval/short-turns.wav', 'eval/short-turns.json')

  console.log(`\n  enrollment  fixtures/conversation.wav (${enrollment.turns.length} turns)`)
  console.log(`  evaluating  eval/short-turns.wav (${test.turns.length} turns)`)
  console.log(`  threshold   ${ATTRIBUTION_THRESHOLD}   floor ${EMBED_MIN_MS}ms`)

  const prints = await enroll(enrollment, nameFor)
  const embeddings = await embedTurns(test)

  report('baseline — attribute each turn on its own', test, runBaseline(test, embeddings, prints))
  const clustered = await runClustered(test, embeddings, prints)
  report('clustered — pool turns into speakers, then attribute', test, clustered.verdicts)
  console.log(`\n  ${clustered.clusters} clusters found for ${new Set(test.turns.map((t) => t.speaker)).size} real speakers`)

  if (process.argv.includes('--verbose')) {
    console.log('\n  per-turn detail (clustered)')
    console.log('  ' + '-'.repeat(58))
    for (const turn of test.turns) {
      const verdict = clustered.verdicts.get(turn.utterance_id)!
      const mark = verdict === 'correct' ? '  ' : verdict === 'wrong' ? '->' : ' ?'
      const how = clustered.reasons.get(turn.utterance_id)
      console.log(
        `  ${mark} ${turn.utterance_id.padEnd(4)}${String(turn.end_ms - turn.start_ms).padStart(6)}ms  ` +
          `${turn.speaker.padEnd(6)} ${(how ?? 'unplaced').padEnd(9)} "${turn.text}"`,
      )
    }
  }
  console.log()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
