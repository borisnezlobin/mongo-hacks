/**
 * What each camera track has been doing lately. Pure, no I/O, no writes.
 *
 * A single frame is never evidence of anything: the detector is confident on
 * blur, on a photograph on a wall, and on a stranger who happens to look like
 * somebody. FACE_CONFIRM_FRAMES consecutive frames of one track agreeing on one
 * person is the guard, and this is where that count lives.
 *
 * Buckets are keyed by conversation, with everything seen outside a
 * conversation in one 'idle' bucket. The split is a privacy boundary, not a
 * convenience: idle observations are held only long enough to recognise
 * somebody walking up (PREROLL_MS) and are never offered to the audio session
 * as evidence about a turn, because there is no recording for them to be
 * evidence about.
 */

import type { FaceClaim, Id, IdentityConfidence } from '../../shared/contracts'
import { FACE_CONFIRM_FRAMES, FACE_OBSERVATION_INTERVAL_MS, PREROLL_MS } from '../../shared/contracts'

/** Everything outside a conversation shares one bucket, pruned to PREROLL_MS. */
export const IDLE_BUCKET = 'idle'

export interface TrackObservation {
  track_id: Id
  /** Who this frame matched, if anybody. Absent is an unrecognised face. */
  person_id?: Id
  score: number
  frame_ts_ms: number
  /** Position in the conversation's audio clock. Absent while idle. */
  stream_ms?: number
  is_near: boolean
  is_active_speaker: boolean
}

export interface TrackState {
  track_id: Id
  person_id?: Id
  /** Frames in a row this track has matched the same person. */
  consecutive: number
  /** Frames in a row this track has matched nobody. */
  unmatched: number
  score: number
  is_near: boolean
  is_active_speaker: boolean
  last_frame_ts_ms: number
  /** A faceprint has already been written for this track; do not write another. */
  reinforced: boolean
}

export interface Span {
  start_ms: number
  end_ms: number
}

interface Track extends TrackState {
  observations: TrackObservation[]
}

export function bucketKeyFor(conversationId?: Id): string {
  return conversationId ?? IDLE_BUCKET
}

/** Confirmed once a track has held one person for FACE_CONFIRM_FRAMES frames. */
export function confidenceForFrames(consecutive: number): IdentityConfidence {
  if (consecutive >= FACE_CONFIRM_FRAMES) return 'confirmed'
  return consecutive > 0 ? 'provisional' : 'pending'
}

/**
 * A frame covers the interval up to the next observation the uploader would
 * send, so one observation is one FACE_OBSERVATION_INTERVAL_MS of evidence
 * rather than an instant with no duration.
 */
function spanOf(observation: TrackObservation): Span | null {
  if (observation.stream_ms === undefined) return null
  return { start_ms: observation.stream_ms, end_ms: observation.stream_ms + FACE_OBSERVATION_INTERVAL_MS }
}

function overlaps(left: Span, right: Span): boolean {
  return left.start_ms < right.end_ms && right.start_ms < left.end_ms
}

function mergeSpans(spans: Span[]): Span[] {
  const sorted = [...spans].sort((left, right) => left.start_ms - right.start_ms)
  const merged: Span[] = []
  for (const span of sorted) {
    const last = merged[merged.length - 1]
    if (last && span.start_ms <= last.end_ms) last.end_ms = Math.max(last.end_ms, span.end_ms)
    else merged.push({ ...span })
  }
  return merged
}

export class FaceTrackLedger {
  private readonly buckets = new Map<string, Map<Id, Track>>()

  /**
   * Fold one observation into its track and hand back what the track now looks
   * like. A track that changes person starts its count again from one: the
   * matcher changing its mind is exactly the case FACE_CONFIRM_FRAMES exists to
   * catch, so it must not inherit the confidence of the person it dropped.
   */
  observe(conversationId: Id | undefined, observation: TrackObservation): TrackState {
    const key = bucketKeyFor(conversationId)
    const bucket = this.bucketFor(key)
    const existing = bucket.get(observation.track_id)
    const track = existing ?? {
      track_id: observation.track_id,
      consecutive: 0,
      unmatched: 0,
      score: 0,
      is_near: observation.is_near,
      is_active_speaker: observation.is_active_speaker,
      last_frame_ts_ms: observation.frame_ts_ms,
      reinforced: false,
      observations: [],
    }

    if (observation.person_id === undefined) {
      track.consecutive = 0
      track.unmatched += 1
      track.person_id = undefined
    } else {
      track.consecutive = observation.person_id === track.person_id ? track.consecutive + 1 : 1
      track.unmatched = 0
      track.person_id = observation.person_id
    }
    track.score = observation.score
    track.is_near = observation.is_near
    track.is_active_speaker = observation.is_active_speaker
    track.last_frame_ts_ms = observation.frame_ts_ms
    track.observations.push(observation)
    bucket.set(observation.track_id, track)

    if (key === IDLE_BUCKET) this.pruneIdle(observation.frame_ts_ms)
    return snapshot(track)
  }

  /** Remember that this track's faceprint has been written, so it writes once. */
  markReinforced(conversationId: Id | undefined, trackId: Id): void {
    const track = this.bucketFor(bucketKeyFor(conversationId)).get(trackId)
    if (track) track.reinforced = true
  }

  trackFor(conversationId: Id | undefined, trackId: Id): TrackState | undefined {
    const track = this.bucketFor(bucketKeyFor(conversationId)).get(trackId)
    return track ? snapshot(track) : undefined
  }

  consecutiveFor(conversationId: Id | undefined, trackId: Id): number {
    return this.bucketFor(bucketKeyFor(conversationId)).get(trackId)?.consecutive ?? 0
  }

  confidenceFor(conversationId: Id | undefined, trackId: Id): IdentityConfidence {
    return confidenceForFrames(this.consecutiveFor(conversationId, trackId))
  }

  /** People other tracks in this bucket already hold, so no two tracks share one. */
  confirmedElsewhere(conversationId: Id | undefined, trackId: Id): Id[] {
    const held: Id[] = []
    for (const track of this.bucketFor(bucketKeyFor(conversationId)).values()) {
      if (track.track_id === trackId || !track.person_id) continue
      if (track.consecutive >= FACE_CONFIRM_FRAMES) held.push(track.person_id)
    }
    return held
  }

  /** Merged stretches of the audio clock where this track was the one talking. */
  speakingSegmentsFor(conversationId: Id, trackId: Id): Span[] {
    const track = this.bucketFor(conversationId).get(trackId)
    if (!track) return []
    const spans = track.observations
      .filter((observation) => observation.is_active_speaker)
      .map(spanOf)
      .filter((span): span is Span => span !== null)
    return mergeSpans(spans)
  }

  /**
   * What the face lane can say about a stretch of a conversation's audio.
   *
   * The idle bucket is not answerable: nothing was recorded while it was
   * filling, so it has no audio clock and no turn to be evidence about.
   */
  claimsOverlapping(conversationId: Id | undefined, spans: readonly Span[]): FaceClaim[] {
    if (conversationId === undefined || spans.length === 0) return []
    const claims: FaceClaim[] = []
    for (const track of this.bucketFor(conversationId).values()) {
      const seen = track.observations
        .map(spanOf)
        .filter((span): span is Span => span !== null)
        .filter((span) => spans.some((query) => overlaps(span, query)))
      if (seen.length === 0) continue
      const speaking = this.speakingSegmentsFor(conversationId, track.track_id).some((segment) =>
        spans.some((query) => overlaps(segment, query)),
      )
      claims.push({
        ...(track.person_id ? { person_id: track.person_id } : {}),
        track_id: track.track_id,
        confidence: confidenceForFrames(track.consecutive),
        score: track.score,
        is_near: track.is_near,
        speaking,
      })
    }
    return claims
  }

  /** Everything a conversation knew, dropped when it ends. */
  release(conversationId: Id): void {
    this.buckets.delete(conversationId)
  }

  private bucketFor(key: string): Map<Id, Track> {
    const existing = this.buckets.get(key)
    if (existing) return existing
    const created = new Map<Id, Track>()
    this.buckets.set(key, created)
    return created
  }

  /**
   * Idle observations older than the pre-roll are dropped outright.
   *
   * The camera polls whenever the glasses are connected, so this bucket fills
   * all day. It exists to recognise the person walking up to you; keeping it
   * any longer would be a log of everyone you looked at, which is the thing the
   * idle path is written to avoid.
   */
  private pruneIdle(nowMs: number): void {
    const bucket = this.buckets.get(IDLE_BUCKET)
    if (!bucket) return
    const cutoff = nowMs - PREROLL_MS
    for (const [trackId, track] of bucket) {
      track.observations = track.observations.filter((observation) => observation.frame_ts_ms >= cutoff)
      if (track.observations.length === 0) bucket.delete(trackId)
    }
  }
}

function snapshot(track: Track): TrackState {
  const { observations: _observations, ...state } = track
  return { ...state }
}
