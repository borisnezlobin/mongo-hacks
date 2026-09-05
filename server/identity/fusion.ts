/**
 * Combining two independent identifiers into one claim.
 *
 * A voice cosine and a face cosine measure different things about the same
 * person, which is the whole reason to have both: the failure modes do not
 * overlap. A voice heard across a noisy room is thin evidence at the same
 * moment the face in front of the camera is excellent evidence, and twenty
 * seconds later the person turns away and it is the other way round. So neither
 * identifier is subordinate to the other here — either can carry a claim alone,
 * and when both speak they multiply.
 *
 * The multiplication is on calibrated probabilities, not on cosines. Cosines
 * from two different models are not commensurable — 0.5 is a stranger for faces
 * and an ordinary impostor for voices — so they are each mapped through their
 * own Calibration first (see VOICE_CALIBRATION and FACE_CALIBRATION in
 * shared/contracts.ts) and combined as independent evidence against an even
 * prior, which is the renormalisation below.
 *
 * The one thing this refuses to do is resolve a disagreement. Two confident
 * identifiers naming different people means either two records are one person
 * or one matcher is wrong, and both readings are questions for the owner. A
 * fused answer there would silently pick a winner, and the losing person's
 * facts would be filed under the winner's name forever.
 *
 * Pure and synchronous: no I/O, no clock, no collections.
 */

import type { FaceClaim, Id, IdentityConfidence, IdentitySource } from '../../shared/contracts'
import { FACE_CALIBRATION, VOICE_CALIBRATION } from '../../shared/contracts'
import { calibratedProbability } from './score-norm'
import type { Decision } from './matcher'

export type FusedDecision =
  | {
      status: 'matched'
      person_id: Id
      /** The print that matched, when a voice matched. Absent for a face-only claim. */
      voiceprint_id?: Id
      source: IdentitySource
      confidence: IdentityConfidence
      /** Calibrated probability behind the claim, in [0, 1]. */
      probability: number
      voice_score: number
      face_score?: number
      face_track_id?: Id
      /**
       * A face vouched for a voice we do not have a print for. See
       * Voiceprint.taught_by: this is what teaches the voice from the face.
       */
      harvest_voice: boolean
      /** Whether this session's pooled speech should strengthen the person's prints. */
      reinforce: boolean
    }
  | {
      status: 'conflict'
      face_person_id: Id
      voice_person_id: Id
      face_score: number
      voice_score: number
    }
  | { status: 'unmatched'; reason: 'no_match' | 'ambiguous'; voice_score: number }

/** A face claim only counts once it has held for FACE_CONFIRM_FRAMES. */
function confirmedFace(face?: FaceClaim): (FaceClaim & { person_id: Id }) | undefined {
  if (!face || face.confidence !== 'confirmed' || !face.person_id) return undefined
  return face as FaceClaim & { person_id: Id }
}

function bothAgree(voice: Decision, face?: FaceClaim): boolean {
  const confirmed = confirmedFace(face)
  return voice.status === 'matched' && confirmed !== undefined && confirmed.person_id === voice.person_id
}

/** A face we are sure of over a voice that named nobody. */
function faceConfirmedVoiceSilent(voice: Decision, face?: FaceClaim): boolean {
  return confirmedFace(face) !== undefined && voice.status !== 'matched'
}

function bothConfirmedDifferent(voice: Decision, voiceTier: IdentityConfidence, face?: FaceClaim): boolean {
  const confirmed = confirmedFace(face)
  return (
    voice.status === 'matched' &&
    voiceTier === 'confirmed' &&
    confirmed !== undefined &&
    confirmed.person_id !== voice.person_id
  )
}

/** The face is sure and the voice is only guessing, so the face wins outright. */
function faceConfirmedVoiceProvisionalDifferent(
  voice: Decision,
  voiceTier: IdentityConfidence,
  face?: FaceClaim,
): boolean {
  const confirmed = confirmedFace(face)
  return (
    voice.status === 'matched' &&
    voiceTier !== 'confirmed' &&
    confirmed !== undefined &&
    confirmed.person_id !== voice.person_id
  )
}

function voiceOnly(face?: FaceClaim): boolean {
  return confirmedFace(face) === undefined
}

/**
 * Two independent probabilities of the same proposition, combined against an
 * even prior and renormalised so the result is a probability again.
 *
 * `p = ab / (ab + (1-a)(1-b))`. Monotonic in both arguments, symmetric, and it
 * leaves either side alone when the other is uninformative at 0.5 — which is
 * the property that lets one identifier carry a claim on its own.
 */
export function fuseProbabilities(a: number, b: number): number {
  const agree = a * b
  const disagree = (1 - a) * (1 - b)
  return agree + disagree === 0 ? 0.5 : agree / (agree + disagree)
}

function voiceProbability(score: number): number {
  return calibratedProbability(score, VOICE_CALIBRATION)
}

function faceProbability(score: number): number {
  return calibratedProbability(score, FACE_CALIBRATION)
}

function unmatched(voice: Decision): FusedDecision {
  return {
    status: 'unmatched',
    reason: voice.status === 'ambiguous' ? 'ambiguous' : 'no_match',
    voice_score: voice.score,
  }
}

function fromFaceAlone(
  voice: Decision,
  face: FaceClaim & { person_id: Id },
  harvestVoice: boolean,
): FusedDecision {
  return {
    status: 'matched',
    person_id: face.person_id,
    source: 'face',
    confidence: 'confirmed',
    probability: faceProbability(face.score),
    voice_score: voice.score,
    face_score: face.score,
    face_track_id: face.track_id,
    harvest_voice: harvestVoice,
    reinforce: false,
  }
}

/**
 * One cluster's voice decision, its speech tier, and the face looking at the
 * camera while it spoke, resolved into a single claim.
 */
export function fuse(voice: Decision, voiceTier: IdentityConfidence, face?: FaceClaim): FusedDecision {
  if (bothConfirmedDifferent(voice, voiceTier, face)) {
    const confirmed = confirmedFace(face)!
    return {
      status: 'conflict',
      face_person_id: confirmed.person_id,
      voice_person_id: (voice as Extract<Decision, { status: 'matched' }>).person_id,
      face_score: confirmed.score,
      voice_score: voice.score,
    }
  }

  if (faceConfirmedVoiceProvisionalDifferent(voice, voiceTier, face)) {
    // The face wins and teaches nothing. This pooled speech already resembles
    // somebody else enough to be a guess, so writing it onto the face's person
    // is exactly how a voiceprint set quietly acquires a second person's voice.
    return fromFaceAlone(voice, confirmedFace(face)!, false)
  }

  if (faceConfirmedVoiceSilent(voice, face)) {
    // A known face over a voice we cannot place: the case the harvest exists
    // for. Speech too thin to embed teaches nothing, and the service floors it
    // again at EMBED_MIN_MS; this only says the evidence is not in the way.
    return fromFaceAlone(voice, confirmedFace(face)!, voiceTier !== 'pending')
  }

  if (bothAgree(voice, face)) {
    const confirmed = confirmedFace(face)!
    const matched = voice as Extract<Decision, { status: 'matched' }>
    return {
      status: 'matched',
      person_id: matched.person_id,
      voiceprint_id: matched.voiceprint_id,
      source: 'both',
      confidence: 'confirmed',
      probability: fuseProbabilities(voiceProbability(matched.score), faceProbability(confirmed.score)),
      voice_score: matched.score,
      face_score: confirmed.score,
      face_track_id: confirmed.track_id,
      harvest_voice: false,
      reinforce: true,
    }
  }

  if (voiceOnly(face) && voice.status === 'matched') {
    return {
      status: 'matched',
      person_id: voice.person_id,
      voiceprint_id: voice.voiceprint_id,
      source: 'voice',
      confidence: voiceTier,
      probability: voiceProbability(voice.score),
      voice_score: voice.score,
      harvest_voice: false,
      reinforce: voiceTier === 'confirmed',
    }
  }
  return unmatched(voice)
}
