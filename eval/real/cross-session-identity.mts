/**
 * Four real conversations, played through the shipped matcher in order.
 *
 * The product promise is that somebody heard in one conversation comes back as
 * the same person in the next. Nothing had ever run that end to end: every
 * calibration in shared/contracts.ts was measured inside a single recording,
 * and inside a single recording the question is trivially easier, because both
 * sides of every comparison share a room, a microphone and a gain setting.
 *
 * This does not re-implement anything. It builds one pooled model per
 * diarization cluster, hands them to `assignClusters` exactly as the audio
 * session does, enrolls what comes back as new people, and moves on to the next
 * recording carrying the voiceprint store forward. What it prints is what the
 * product would have believed.
 *
 *   bun eval/real/cross-session-identity.mts --pools ecapa --seconds 60
 *   bun eval/real/cross-session-identity.mts --pools wespeaker --seconds 20
 *   bun eval/real/cross-session-identity.mts --threshold 0.5
 *
 * `--pools` reads the pooled-AUDIO voiceprints cluster_pools.py writes, which is
 * what the product builds. Without it the models are averages of the cached
 * per-turn vectors, which is a different and measurably worse thing: on fifty
 * seconds spread over ten turns the average scored 0.44 where the pooled audio
 * scored 0.72 against the same person in another room.
 *
 * Ground truth for the clusters is in TRUTH, with the provenance of each label.
 * Real-people data: reads gitignored fixtures, prints no transcript text.
 */

import { readFileSync } from 'node:fs'
import {
  ATTRIBUTION_MARGIN,
  ATTRIBUTION_THRESHOLD,
  CONFIRMED_SPEECH_MS,
  CROSS_SESSION_SPEECH_MS,
  MAX_VOICEPRINTS_PER_PERSON,
} from '../../shared/contracts'
import { assignClusters, confidenceFor, selectEvictions, type ClusterQuery, type ScorablePrint } from '../../server/identity/matcher'
import { mergeCandidates } from '../../server/identity/duplicates'

/** Recordings in the order they happened, which is the order the product sees. */
const RECORDINGS = ['dorm-9pm', 'dorm-40min', 'jerry-45min', 'mentra-mtg'] as const

/**
 * Cluster -> person, strongest provenance first. These are NOT equally good and
 * the difference has already cost one wrong report, so the tier is recorded:
 *
 *   OWNER-CONFIRMED
 *     dorm-9pm/*            eval/landmarks.ts, lines the owner identified
 *     jerry-45min/03        the owner confirmed Tarun said the GBO check-in line
 *   REFERENCE SPANS, and they contradict him in places
 *     dorm-40min/*          by majority overlap. The reference calls the line he
 *                           identified as Dhruv "tarun" and the one he identified
 *                           as Clara "boris"; prefer eval/landmarks.ts on conflict
 *   HYPOTHESIS, from the transcript alone
 *     jerry-45min/04        addresses "Jerry" six times, so is not Jerry. Also
 *                           matches the landmark-grounded dorm-9pm/boris at 0.788
 *     mentra-mtg/02         calls Amelia "our hackathon project"
 *     mentra-mtg/00, /03    see the mentra-mtg warning below
 *
 * mentra-mtg is TWO PHYSICAL SOURCES, not five people: Alex, David and Brendan
 * were all remote, so SPEAKER_00 is a laptop speaker carrying three of them and
 * scores near-orthogonally to every in-room voice. Naming it "alex" is a
 * convenience; it is a channel. Do not read anything here as evidence about
 * in-room diarization.
 *
 * Clusters absent from this table are people we have no independent label for.
 */
const TRUTH: Record<string, string> = {
  'dorm-9pm/SPEAKER_01': 'joshua',
  'dorm-9pm/SPEAKER_02': 'boris',
  'dorm-9pm/SPEAKER_03': 'tarun',
  'dorm-40min/SPEAKER_04': 'boris',
  'dorm-40min/SPEAKER_06': 'tarun',
  'jerry-45min/SPEAKER_03': 'tarun',
  'jerry-45min/SPEAKER_04': 'boris',
  'mentra-mtg/SPEAKER_00': 'alex',
  'mentra-mtg/SPEAKER_02': 'boris',
  'mentra-mtg/SPEAKER_03': 'brendan',
}

const MIN_TURN_MS = 700
const MIN_CLUSTER_MS = 20_000

interface Turn {
  speaker: string
  exclusive_ms: number
  vector: number[] | null
}

function options() {
  const argv = process.argv.slice(2)
  const read = (flag: string, fallback: string) => {
    const at = argv.indexOf(flag)
    return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback
  }
  return {
    suffix: read('--model', 'wespeaker') === 'ecapa' ? '.ecapa' : '',
    pools: argv.includes('--pools') ? read('--pools', 'ecapa') : null,
    seconds: Number(read('--seconds', '60')),
    threshold: Number(read('--threshold', String(ATTRIBUTION_THRESHOLD))),
    margin: Number(read('--margin', String(ATTRIBUTION_MARGIN))),
  }
}

/**
 * One pooled-audio voiceprint per cluster: the longest rung of the ladder that
 * cluster reached, capped at `seconds`. A cluster with less speech than that
 * still enters with what it has, because refusing to consider short clusters is
 * a different decision and belongs to confidenceFor, not to the loader.
 */
function pooledFromAudio(stem: string, tag: string, seconds: number): ClusterQuery[] {
  const rows: { cluster: string; duration: number; trial: number; vector: number[]; available_s: number }[] =
    JSON.parse(readFileSync(`eval/real/${stem}.clusterpool.${tag}.json`, 'utf8')).pools
  const best = new Map<string, (typeof rows)[number]>()
  for (const row of rows) {
    if (row.duration > seconds || row.trial !== 0) continue
    const incumbent = best.get(row.cluster)
    if (!incumbent || row.duration > incumbent.duration) best.set(row.cluster, row)
  }
  return [...best.values()]
    .map((row) => ({
      key: `${stem}/${row.cluster}`,
      embedding: row.vector,
      duration_ms: row.duration * 1000,
    }))
    .sort((left, right) => right.duration_ms - left.duration_ms)
}

function pooledClusters(stem: string, suffix: string): ClusterQuery[] {
  const turns: Turn[] = JSON.parse(readFileSync(`eval/real/${stem}.turnemb${suffix}.json`, 'utf8')).turns
  const grouped = new Map<string, Turn[]>()
  for (const turn of turns) {
    if (!turn.vector || turn.exclusive_ms < MIN_TURN_MS) continue
    const bucket = grouped.get(turn.speaker) ?? []
    bucket.push(turn)
    grouped.set(turn.speaker, bucket)
  }
  const clusters: ClusterQuery[] = []
  for (const [speaker, members] of grouped) {
    const duration = members.reduce((total, turn) => total + turn.exclusive_ms, 0)
    if (duration < MIN_CLUSTER_MS) continue
    const dimensions = members[0].vector!.length
    const sum = new Array<number>(dimensions).fill(0)
    for (const turn of members) {
      for (let index = 0; index < dimensions; index += 1) sum[index] += turn.vector![index] * turn.exclusive_ms
    }
    const magnitude = Math.sqrt(sum.reduce((total, value) => total + value * value, 0))
    clusters.push({
      key: `${stem}/${speaker}`,
      embedding: sum.map((value) => value / magnitude),
      duration_ms: duration,
    })
  }
  return clusters.sort((left, right) => right.duration_ms - left.duration_ms)
}

function main(): void {
  const { suffix, pools, seconds, threshold, margin } = options()
  console.log(
    pools
      ? `pooled-audio voiceprints, ${pools}, up to ${seconds}s per cluster`
      : `averaged per-turn vectors, ${suffix === '.ecapa' ? 'ecapa' : 'wespeaker'}`,
  )
  console.log(`threshold ${threshold}, margin ${margin}, confirmed at ${CONFIRMED_SPEECH_MS / 1000}s\n`)

  const prints: (ScorablePrint & { created_at: string; duration_ms: number })[] = []
  const members = new Map<string, string[]>()
  let nextPerson = 0
  let storedBefore = 0
  let storedNow = 0

  for (const stem of RECORDINGS) {
    const clusters = pools ? pooledFromAudio(stem, pools, seconds) : pooledClusters(stem, suffix)
    const decisions = assignClusters(clusters, prints, { threshold, margin })
    console.log(`${stem}: ${clusters.length} clusters`)
    for (const cluster of clusters) {
      const decision = decisions.get(cluster.key)!
      const truth = TRUTH[cluster.key] ?? '?'
      let personId: string
      if (decision.status === 'matched') {
        personId = decision.person_id
      } else {
        personId = `person-${nextPerson += 1}`
      }
      members.set(personId, [...(members.get(personId) ?? []), cluster.key])
      const pooled = (cluster.duration_ms / 1000).toFixed(0)
      const runnerUp = 'runner_up' in decision && Number.isFinite(decision.runner_up) ? decision.runner_up.toFixed(3) : '-'
      console.log(
        `  ${cluster.key.padEnd(24)} ${pooled.padStart(4)}s truth=${truth.padEnd(8)} ` +
          `${decision.status.padEnd(10)} score ${('score' in decision ? decision.score : 0).toFixed(3)} ` +
          `runner-up ${runnerUp.padStart(6)} -> ${personId} [${confidenceFor(cluster.duration_ms)}]`,
      )
      // What the service now writes: thin pooled speech earns no print unless
      // the person has none at all. Counted both ways so the cost of the rule
      // is visible rather than asserted.
      const firstForPerson = !prints.some((print) => print.person_id === personId)
      const wouldStoreBefore = confidenceFor(cluster.duration_ms) === 'confirmed'
      const wouldStoreNow =
        wouldStoreBefore && (firstForPerson || cluster.duration_ms >= CROSS_SESSION_SPEECH_MS)
      if (wouldStoreBefore) storedBefore += 1
      if (wouldStoreNow) storedNow += 1
      if (wouldStoreNow) {
        prints.push({
          _id: `print-${prints.length}`,
          person_id: personId,
          embedding: cluster.embedding,
          created_at: new Date(prints.length * 1000).toISOString(),
          duration_ms: cluster.duration_ms,
        })
        const owned = prints.filter((print) => print.person_id === personId)
        const evictions = new Set(selectEvictions(owned, MAX_VOICEPRINTS_PER_PERSON))
        for (let index = prints.length - 1; index >= 0; index -= 1) {
          if (evictions.has(prints[index]._id)) prints.splice(index, 1)
        }
      }
    }
    console.log()
  }

  console.log('people the product would have ended up with:')
  let splits = 0
  let merges = 0
  const seen = new Map<string, string[]>()
  for (const [personId, keys] of [...members].sort((a, b) => b[1].length - a[1].length)) {
    const truths = keys.map((key) => TRUTH[key] ?? '?')
    const known = new Set(truths.filter((name) => name !== '?'))
    const verdict = known.size > 1 ? 'MERGE of ' + [...known].join(' + ') : ''
    if (known.size > 1) merges += 1
    for (const name of known) seen.set(name, [...(seen.get(name) ?? []), personId])
    console.log(`  ${personId.padEnd(10)} ${keys.length} cluster(s): ${keys.join(', ')}  ${verdict}`)
  }
  console.log()
  for (const [name, people] of [...seen].sort()) {
    if (people.length > 1) splits += 1
    const recordings = new Set(
      Object.entries(TRUTH)
        .filter(([, who]) => who === name)
        .map(([key]) => key.split('/')[0]),
    )
    console.log(
      `  ${name.padEnd(8)} appears in ${recordings.size} recording(s), ended up as ${people.length} person record(s)` +
        (people.length > 1 ? `  SPLIT: ${people.join(', ')}` : '  linked'),
    )
  }
  console.log(`\n${splits} split(s), ${merges} merge(s)`)
  console.log(
    `prints written: ${storedBefore} under the old rule (every confirmed cluster), ` +
      `${storedNow} under the new one (>= ${CROSS_SESSION_SPEECH_MS / 1000}s, or a person's first)`,
  )
  const printless = [...members.keys()].filter(
    (personId) => !prints.some((print) => print.person_id === personId),
  )
  console.log(
    `people left with no print at all: ${printless.length} of ${members.size}` +
      (printless.length ? ` — ${printless.join(', ')}` : ' — every voice stays identifiable'),
  )

  // What the after-the-fact sweep would offer the owner, given exactly the
  // prints this run wrote. Its recall is bounded by print quality like
  // everything else here, so a run on thin models finds less than one on good.
  const synthesised = [...members.keys()].map((personId) => ({
    _id: personId,
    owner_id: 'owner',
    name: 'Unnamed voice',
    is_unnamed: true,
    created_at: personId,
    updated_at: personId,
  }))
  const withDurations = prints.map((print) => ({
    ...print,
    owner_id: 'owner',
    created_at: print.created_at,
    duration_ms: print.duration_ms,
  }))
  const candidates = mergeCandidates(synthesised, withDurations as never)
  console.log(`\nduplicate pairs the sweep would propose: ${candidates.length}`)
  for (const candidate of candidates) {
    const [left, right] = candidate.sides
    const truthOf = (personId: string) =>
      [...new Set((members.get(personId) ?? []).map((key) => TRUTH[key] ?? '?'))].join('/')
    console.log(
      `  ${candidate.score.toFixed(3)}  ${left.person_id} (${truthOf(left.person_id)}) ` +
        `+ ${right.person_id} (${truthOf(right.person_id)})` +
        (truthOf(left.person_id) === '?' || truthOf(right.person_id) === '?'
          ? '  unlabelled'
          : truthOf(left.person_id) === truthOf(right.person_id)
            ? '  CORRECT'
            : '  WRONG'),
    )
  }
}

main()
