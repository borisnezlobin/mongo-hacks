/**
 * Groups the turns of one session into speaker clusters.
 *
 * This exists because attributing individual turns to people does not work.
 * Speaker-verification error is dominated by duration — ERes2NetV2 on
 * VoxCeleb1-O goes 0.61% EER at full duration, 0.98% at 3s, 1.48% at 2s, and
 * falls apart below that even in clean lab conditions. Most turns in real
 * conversation are shorter than that, so matching them one at a time against a
 * voiceprint is close to a coin flip.
 *
 * Clustering moves the hard comparison. Turns within one session share a
 * speaker, a microphone, and a room, so telling them apart is easy: measured on
 * our own fixture, within-speaker cosine bottomed at 0.758 while cross-speaker
 * peaked at 0.259. Only once a cluster has pooled enough audio do we make the
 * genuinely hard cross-session, cross-channel comparison against enrolled
 * people — once, with plenty of speech, instead of per turn with almost none.
 *
 * A half-second "yeah" therefore never needs to be recognised on its own. It
 * joins the cluster it sounds most like and inherits that cluster's name.
 *
 * Pure and synchronous: embeddings come in, cluster ids go out. No network, no
 * database, no audio handling.
 */

import { VOICEPRINT_DIMS } from '../../shared/contracts'

/**
 * Below this, a turn may join an existing cluster but may never start a new
 * one. Short embeddings are informative enough to say "that sounded like Ann"
 * and far too noisy to say "that was nobody we have heard yet" — letting them
 * open clusters is how one speaker shatters into six.
 */
export const MIN_NEW_CLUSTER_MS = 1_500

/**
 * Turns shorter than this carry too little signal to embed at all. They are
 * held and resolved by adjacency instead. Kept low deliberately: a noisy
 * 300 ms embedding still beats assuming a backchannel belongs to whoever was
 * talking before it, because a backchannel is by definition a reply to someone
 * else.
 */
export const MIN_EMBED_MS = 250

/**
 * Cosine below which a turn is considered a different speaker. Deliberately
 * well under the within-speaker floor we measured and well over the
 * cross-speaker ceiling; the gap in single-session audio is wide enough that
 * this does not need to be delicate.
 */
export const LINK_THRESHOLD = 0.5

/**
 * How close in time an unembeddable turn has to be to a cluster to inherit it.
 * A backchannel lands inside the pause of the person it answers, so proximity
 * is the only cue available and it is a decent one at this range.
 */
export const ADJACENCY_WINDOW_MS = 1_200

export interface TurnRef {
  /** Provider-assigned label for this turn, e.g. 'turn-7'. */
  label: string
  start_ms: number
  end_ms: number
}

export interface Cluster {
  id: string
  /** Running sum of member embeddings; the centroid is this normalised. */
  centroid: number[]
  members: TurnRef[]
  speechMs: number
}

export interface Assignment {
  label: string
  clusterId: string
  /** Cosine against the cluster it joined, or null when placed by adjacency. */
  similarity: number | null
  reason: 'matched' | 'created' | 'adjacent' | 'nearest'
}

interface Deferred {
  turn: TurnRef
  embedding: number[] | null
}

export class SpeakerClusterer {
  private readonly clusters: Cluster[] = []
  private nextId = 0
  /** Turns we could not place yet, held until the picture improves. */
  private readonly deferred: Deferred[] = []

  /**
   * Place one turn. `embedding` may be null for turns under MIN_EMBED_MS.
   *
   * Returns assignments for this turn *and* for any previously deferred turn
   * that this one made resolvable, so a caller can relabel retroactively. A
   * turn that still cannot be placed produces nothing now and is retried on
   * every later call.
   */
  add(turn: TurnRef, embedding: number[] | null): Assignment[] {
    const durationMs = turn.end_ms - turn.start_ms
    if (embedding && embedding.length !== VOICEPRINT_DIMS) {
      throw new Error(`expected ${VOICEPRINT_DIMS}-dim embedding, got ${embedding.length}`)
    }
    if (!embedding || durationMs < MIN_EMBED_MS) {
      this.deferred.push({ turn, embedding: null })
      return this.drainDeferred()
    }

    const best = this.nearest(embedding)
    if (best && best.similarity >= LINK_THRESHOLD) {
      this.absorb(best.cluster, turn, embedding, durationMs)
      return [
        { label: turn.label, clusterId: best.cluster.id, similarity: best.similarity, reason: 'matched' },
        ...this.drainDeferred(),
      ]
    }
    if (durationMs >= MIN_NEW_CLUSTER_MS || this.clusters.length === 0) {
      const created = this.create(turn, embedding, durationMs)
      return [
        { label: turn.label, clusterId: created.id, similarity: best?.similarity ?? null, reason: 'created' },
        ...this.drainDeferred(),
      ]
    }

    // Too short to be believed as a new speaker, and unlike everyone we have
    // heard so far. Usually that means the speaker simply has not had a long
    // enough turn yet — the first "Yeah?" of a conversation arrives before the
    // person who said it. Forcing it into the nearest cluster here is how a
    // backchannel ends up credited to whoever was talking before it, so hold it
    // and try again once there is someone better to compare against.
    this.deferred.push({ turn, embedding })
    return this.drainDeferred()
  }

  /**
   * Place everything still held, now that no more turns are coming. Confidence
   * thresholds are dropped: at this point a best guess beats no name at all,
   * and the user can correct it.
   */
  flush(): Assignment[] {
    const resolved = this.drainDeferred()
    for (let i = this.deferred.length - 1; i >= 0; i -= 1) {
      const { turn, embedding } = this.deferred[i]
      const best = embedding ? this.nearest(embedding) : null
      const cluster = best?.cluster ?? this.closestInTime(turn, Number.POSITIVE_INFINITY)
      if (!cluster) continue
      this.attach(cluster, turn)
      resolved.push({
        label: turn.label,
        clusterId: cluster.id,
        similarity: best?.similarity ?? null,
        reason: best ? 'nearest' : 'adjacent',
      })
      this.deferred.splice(i, 1)
    }
    return resolved
  }

  /** Clusters holding at least minMs of speech, largest first. */
  clustersOverFloor(minMs: number): Cluster[] {
    return this.clusters.filter((c) => c.speechMs >= minMs).sort((a, b) => b.speechMs - a.speechMs)
  }

  get all(): readonly Cluster[] {
    return this.clusters
  }

  private nearest(embedding: number[]): { cluster: Cluster; similarity: number } | null {
    let best: { cluster: Cluster; similarity: number } | null = null
    for (const cluster of this.clusters) {
      const similarity = cosine(embedding, cluster.centroid)
      if (!best || similarity > best.similarity) best = { cluster, similarity }
    }
    return best
  }

  private create(turn: TurnRef, embedding: number[], durationMs: number): Cluster {
    const cluster: Cluster = {
      id: `cluster-${this.nextId++}`,
      centroid: [...embedding],
      members: [turn],
      speechMs: durationMs,
    }
    this.clusters.push(cluster)
    return cluster
  }

  /**
   * Fold a turn in, weighting the centroid by duration so a long confident turn
   * counts for more than a clipped one.
   */
  private absorb(cluster: Cluster, turn: TurnRef, embedding: number[], durationMs: number): void {
    const weight = durationMs / (cluster.speechMs + durationMs)
    for (let i = 0; i < cluster.centroid.length; i += 1) {
      cluster.centroid[i] = cluster.centroid[i] * (1 - weight) + embedding[i] * weight
    }
    cluster.members.push(turn)
    cluster.speechMs += durationMs
  }

  /**
   * Retry held-back turns against whatever clusters exist now. Turns that were
   * embeddable are placed by voice once some cluster clears the threshold;
   * turns that were not are placed by nearest boundary in time. Anything still
   * unexplained stays deferred — a later turn may account for it.
   */
  private drainDeferred(): Assignment[] {
    if (this.clusters.length === 0) return []
    const resolved: Assignment[] = []
    for (let i = this.deferred.length - 1; i >= 0; i -= 1) {
      const { turn, embedding } = this.deferred[i]
      if (embedding) {
        const best = this.nearest(embedding)
        if (!best || best.similarity < LINK_THRESHOLD) continue
        this.absorb(best.cluster, turn, embedding, turn.end_ms - turn.start_ms)
        resolved.push({
          label: turn.label,
          clusterId: best.cluster.id,
          similarity: best.similarity,
          reason: 'matched',
        })
      } else {
        const closest = this.closestInTime(turn, ADJACENCY_WINDOW_MS)
        if (!closest) continue
        this.attach(closest, turn)
        resolved.push({ label: turn.label, clusterId: closest.id, similarity: null, reason: 'adjacent' })
      }
      this.deferred.splice(i, 1)
    }
    return resolved
  }

  /** Add a turn's time to a cluster without letting it move the centroid. */
  private attach(cluster: Cluster, turn: TurnRef): void {
    cluster.members.push(turn)
    cluster.speechMs += turn.end_ms - turn.start_ms
  }

  private closestInTime(turn: TurnRef, windowMs: number): Cluster | null {
    let best: { cluster: Cluster; gap: number } | null = null
    for (const cluster of this.clusters) {
      for (const member of cluster.members) {
        const gap =
          member.end_ms <= turn.start_ms
            ? turn.start_ms - member.end_ms
            : member.start_ms >= turn.end_ms
              ? member.start_ms - turn.end_ms
              : 0
        if (gap <= windowMs && (!best || gap < best.gap)) best = { cluster, gap }
      }
    }
    return best?.cluster ?? null
  }
}

/** Cosine similarity. Embeddings arrive L2-normalised, but centroids drift. */
export function cosine(a: number[], b: number[]): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const magnitude = Math.sqrt(normA) * Math.sqrt(normB)
  return magnitude === 0 ? 0 : dot / magnitude
}
