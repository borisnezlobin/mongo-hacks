/**
 * Speaker scoring. Pure, synchronous, no I/O — every threshold decision in the
 * product is made here so it can be tested exhaustively.
 *
 * Two ideas carry it, both measured on fixtures/real/dorm-9pm.wav and written
 * up against the constants in shared/contracts.ts:
 *
 *  1. Absolute distance, on raw embeddings. Most voices this system hears
 *     belong to strangers, so the metric has to be able to say "nobody I
 *     know". Session-mean centering was tried as the gate first and cannot say
 *     it — see scorePrint below for what that cost. Centering is still
 *     available and session means are still stored; they are just not the gate.
 *  2. Best-of-prints. A person accumulates one print per session that confirms
 *     them. Their lecture-hall print should not be dragged down by their dorm
 *     print, so a person scores as the maximum over their prints, never the
 *     mean.
 */

import type { IdentityConfidence, Id, Voiceprint } from '../../shared/contracts'
import {
  ATTRIBUTION_MARGIN,
  ATTRIBUTION_THRESHOLD,
  CONFIRMED_SPEECH_MS,
  PROVISIONAL_SPEECH_MS,
} from '../../shared/contracts'

export type ScorablePrint = Pick<Voiceprint, '_id' | 'person_id' | 'embedding' | 'session_mean'>

export interface PersonScore {
  person_id: Id
  /** The print that scored best for this person. */
  voiceprint_id: Id
  score: number
}

export type Decision =
  | { status: 'matched'; person_id: Id; voiceprint_id: Id; score: number; runner_up: number }
  | { status: 'ambiguous'; person_id: Id; score: number; runner_up: number }
  | { status: 'no_match'; score: number }

export interface MatchOptions {
  threshold?: number
  margin?: number
  /** People already spoken for by another cluster in this same session. */
  taken?: Iterable<Id>
}

export interface ClusterQuery {
  /** Caller's handle for the cluster — a session speaker id, usually. */
  key: string
  embedding: number[]
  session_mean?: number[] | null
  duration_ms: number
}

/** L2 norm, guarding the zero vector so callers never see NaN. */
export function normalize(vector: number[]): number[] {
  let sumOfSquares = 0
  for (const component of vector) sumOfSquares += component * component
  const magnitude = Math.sqrt(sumOfSquares)
  return magnitude === 0 ? vector.map(() => 0) : vector.map((component) => component / magnitude)
}

/**
 * The comparable form of an embedding: channel removed, then re-normalised.
 * A missing session mean is treated as zero, which is exactly what prints
 * captured before session means were recorded should get.
 */
export function centered(embedding: number[], sessionMean?: number[] | null): number[] {
  if (!sessionMean || sessionMean.length === 0) return normalize(embedding)
  return normalize(embedding.map((component, index) => component - (sessionMean[index] ?? 0)))
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0
  let normA = 0
  let normB = 0
  const length = Math.min(a.length, b.length)
  for (let i = 0; i < length; i += 1) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const magnitude = Math.sqrt(normA) * Math.sqrt(normB)
  return magnitude === 0 ? 0 : dot / magnitude
}

/**
 * Score a pooled query against one print, on RAW embeddings.
 *
 * Deliberately not centered. Subtracting each side's session mean was tried
 * first and measurably breaks the case that matters most: with only a few
 * people enrolled, the session mean is dominated by those people rather than by
 * the room, their centered prints come out near-antipodal, and every voice then
 * scores strongly as one of them. A stranger measured 0.499 against a friend
 * that way — there was no longer any such thing as "nobody I know". Rejecting a
 * stranger needs absolute distance, so absolute distance is what this keeps.
 */
export function scorePrint(query: number[], print: ScorablePrint): number {
  return cosine(query, print.embedding)
}

/**
 * Best score per person, highest first. Exact cosine over every print: at tens
 * to low hundreds of prints this is microseconds, and approximate nearest
 * neighbour would only add recall risk for no gain.
 */
/**
 * `sessionMean` is accepted and ignored. Callers hold it, prints carry it, and
 * the day there are enough enrolled people for centering to help at telling
 * them apart, this is where it goes back in — it is not part of the gate.
 */
export function scorePeople(
  embedding: number[],
  sessionMean: number[] | null | undefined,
  prints: readonly ScorablePrint[],
): PersonScore[] {
  void sessionMean
  const best = new Map<Id, PersonScore>()
  for (const print of prints) {
    const score = scorePrint(embedding, print)
    const incumbent = best.get(print.person_id)
    if (!incumbent || score > incumbent.score) {
      best.set(print.person_id, { person_id: print.person_id, voiceprint_id: print._id, score })
    }
  }
  return [...best.values()].sort((left, right) => right.score - left.score)
}

/**
 * Turn ranked scores into a claim, or refuse to.
 *
 * The runner-up is the best score of a *different* person. Two roommates at
 * 0.71 and 0.70 are not an identification, and a fact filed under the wrong
 * roommate is wrong forever, so a thin margin fails closed to `ambiguous`.
 */
export function decide(scores: readonly PersonScore[], options: MatchOptions = {}): Decision {
  const threshold = options.threshold ?? ATTRIBUTION_THRESHOLD
  const margin = options.margin ?? ATTRIBUTION_MARGIN
  const taken = new Set(options.taken ?? [])
  const available = scores.filter((score) => !taken.has(score.person_id))
  const best = available[0]
  if (!best || best.score < threshold) {
    return { status: 'no_match', score: best?.score ?? 0 }
  }
  const runnerUp = available[1]?.score ?? Number.NEGATIVE_INFINITY
  if (best.score - runnerUp < margin) {
    return { status: 'ambiguous', person_id: best.person_id, score: best.score, runner_up: runnerUp }
  }
  return {
    status: 'matched',
    person_id: best.person_id,
    voiceprint_id: best.voiceprint_id,
    score: best.score,
    runner_up: runnerUp,
  }
}

/**
 * How much a claim about `durationMs` of pooled speech is worth. Measured:
 * 65-75% correct at 2-6s, 88% at 8s, 100% at 20s.
 */
export function confidenceFor(durationMs: number): IdentityConfidence {
  if (durationMs >= CONFIRMED_SPEECH_MS) return 'confirmed'
  if (durationMs >= PROVISIONAL_SPEECH_MS) return 'provisional'
  return 'pending'
}

/**
 * Assign every cluster in one session to at most one person, one-to-one.
 *
 * Two distinct clusters in one room are, by construction, two different
 * people, so letting both match the same person is always an error — and it is
 * the error that produces a transcript where one person appears to interrupt
 * themselves. This is an assignment problem; we solve it greedily by
 * descending score with a used-set rather than with Hungarian, because at
 * three-to-ten speakers the optimum and the greedy solution differ only when
 * scores are within a margin of each other, and those pairs are rejected as
 * ambiguous anyway. Greedy is also deterministic and readable, which matters
 * more here than the last fraction of a percent.
 *
 * A person already claimed by a higher-scoring cluster is removed from the
 * runner-up field of later clusters: that competition is settled by the
 * one-to-one constraint, so it should not also count as ambiguity.
 */
export function assignClusters(
  clusters: readonly ClusterQuery[],
  prints: readonly ScorablePrint[],
  options: MatchOptions = {},
): Map<string, Decision> {
  const threshold = options.threshold ?? ATTRIBUTION_THRESHOLD
  const margin = options.margin ?? ATTRIBUTION_MARGIN
  const taken = new Set(options.taken ?? [])

  const ranked = new Map<string, PersonScore[]>()
  const pairs: { key: string; candidate: PersonScore }[] = []
  for (const cluster of clusters) {
    const scores = scorePeople(cluster.embedding, cluster.session_mean, prints)
    ranked.set(cluster.key, scores)
    for (const candidate of scores) {
      if (candidate.score >= threshold && !taken.has(candidate.person_id)) {
        pairs.push({ key: cluster.key, candidate })
      }
    }
  }
  pairs.sort((left, right) => right.candidate.score - left.candidate.score)

  const decisions = new Map<string, Decision>()
  for (const { key, candidate } of pairs) {
    if (decisions.has(key) || taken.has(candidate.person_id)) continue
    const runnerUp = (ranked.get(key) ?? [])
      .filter((score) => score.person_id !== candidate.person_id && !taken.has(score.person_id))
      .reduce((highest, score) => Math.max(highest, score.score), Number.NEGATIVE_INFINITY)
    if (candidate.score - runnerUp < margin) {
      decisions.set(key, {
        status: 'ambiguous',
        person_id: candidate.person_id,
        score: candidate.score,
        runner_up: runnerUp,
      })
      continue
    }
    decisions.set(key, {
      status: 'matched',
      person_id: candidate.person_id,
      voiceprint_id: candidate.voiceprint_id,
      score: candidate.score,
      runner_up: runnerUp,
    })
    taken.add(candidate.person_id)
  }
  for (const cluster of clusters) {
    if (decisions.has(cluster.key)) continue
    decisions.set(cluster.key, { status: 'no_match', score: ranked.get(cluster.key)?.[0]?.score ?? 0 })
  }
  return decisions
}

export interface EvictablePrint {
  _id: Id
  created_at: string
  /**
   * Pooled speech behind this print. The eviction order turns on it: see
   * selectEvictions for the measurement that says so.
   */
  duration_ms?: number
  /** Prints the user made deliberately. Never evicted, whatever the cap says. */
  enrolled?: boolean
}

/**
 * Which of a person's prints to drop to stay under the cap. The thinnest
 * automatic prints go first; a print the user created by enrolling or by naming
 * a voice is never dropped, because it is the only one we know is correct.
 *
 * This used to evict the OLDEST automatic print, which reads like the obvious
 * choice and is measurably the wrong one. How well a print recognises somebody
 * in another room is dominated by how much speech is behind it, and the effect
 * is large — measured cross-recording on four real conversations
 * (eval/real/model_transfer.py), miss rate at ATTRIBUTION_THRESHOLD against a
 * 20s query:
 *
 *   print backed by  20s   18-33% missed
 *   print backed by  60s     1.7% missed
 *   print backed by 120s     1.7% missed
 *
 * So evicting by age throws away a three-hundred-second print from a long
 * dinner to keep a twenty-second one from last week, and that swap costs about
 * seventeen points of recall. Age is kept only as the tie-break, so the result
 * stays deterministic when two prints hold the same amount of speech.
 *
 * A print with no recorded duration sorts as the thinnest: it predates the
 * field, so there is no evidence it is worth keeping over one that has it.
 */
export function selectEvictions(prints: readonly EvictablePrint[], cap: number): Id[] {
  if (prints.length <= cap) return []
  const evictable = prints
    .filter((print) => !print.enrolled)
    .sort((left, right) => {
      const byEvidence = (left.duration_ms ?? 0) - (right.duration_ms ?? 0)
      if (byEvidence !== 0) return byEvidence
      return left.created_at < right.created_at ? -1 : left.created_at > right.created_at ? 1 : 0
    })
  const overflow = prints.length - cap
  return evictable.slice(0, Math.max(0, Math.min(overflow, evictable.length))).map((print) => print._id)
}
