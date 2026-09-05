/**
 * Face scoring. Pure, and deliberately three thin functions over the voice
 * matcher rather than a second matcher.
 *
 * `server/identity/matcher.ts` scores over `Pick<Voiceprint, '_id' |
 * 'person_id' | 'embedding' | 'session_mean'>`, which a `Faceprint` satisfies
 * structurally, so the whole best-of-prints and margin argument written up
 * there applies here unchanged. What differs is only the numbers: faces are
 * L2-normalised InsightFace vectors, so they need their own threshold and
 * margin, and those are placeholders until `bun run eval:faces` measures them.
 */

import type { Faceprint, Id } from '../../shared/contracts'
import { FACE_MATCH_MARGIN, FACE_MATCH_THRESHOLD, MAX_FACEPRINTS_PER_PERSON } from '../../shared/contracts'
import { decide, scorePeople, selectEvictions, type Decision, type PersonScore } from '../identity/matcher'

export type ScorableFaceprint = Pick<Faceprint, '_id' | 'person_id' | 'embedding'>

export type EvictableFaceprint = Pick<Faceprint, '_id' | 'created_at' | 'quality' | 'enrolled'>

export interface FaceMatchOptions {
  /** People another track in this frame already holds: two faces are two people. */
  taken?: Iterable<Id>
}

/**
 * Best score per person. No session mean: a face has no channel to subtract,
 * and the parameter exists on the voice side only because prints carry one.
 */
export function scoreFaces(embedding: number[], prints: readonly ScorableFaceprint[]): PersonScore[] {
  return scorePeople(embedding, null, prints)
}

/** The same margin-checked decision the voice path makes, at face thresholds. */
export function decideFace(scores: readonly PersonScore[], options: FaceMatchOptions = {}): Decision {
  return decide(scores, {
    threshold: FACE_MATCH_THRESHOLD,
    margin: FACE_MATCH_MARGIN,
    taken: options.taken,
  })
}

/**
 * Which of a person's faceprints to drop to stay under the cap.
 *
 * Quality plays the part duration plays for voices: it is the evidence behind
 * the print, so the thinnest evidence goes first and age is only the tie-break.
 * A print the owner enrolled is never dropped, for the same reason as on the
 * voice side — it is the only one we know to be correct.
 */
export function selectWeakestFaceprints(
  prints: readonly EvictableFaceprint[],
  cap: number = MAX_FACEPRINTS_PER_PERSON,
): Id[] {
  return selectEvictions(
    prints.map((print) => ({
      _id: print._id,
      created_at: print.created_at,
      duration_ms: print.quality,
      enrolled: print.enrolled,
    })),
    cap,
  )
}
