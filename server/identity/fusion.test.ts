import { describe, expect, it } from 'vitest'
import type { FaceClaim, IdentityConfidence } from '../../shared/contracts'
import { FACE_CALIBRATION, FACE_MATCH_THRESHOLD, VOICE_CALIBRATION } from '../../shared/contracts'
import { calibratedProbability } from './score-norm'
import type { Decision } from './matcher'
import { fuse, fuseProbabilities } from './fusion'

function voiceMatch(personId: string, score = 0.78): Decision {
  return { status: 'matched', person_id: personId, voiceprint_id: `print-${personId}`, score, runner_up: 0.4 }
}

const NO_VOICE: Decision = { status: 'no_match', score: 0.31 }
const AMBIGUOUS: Decision = { status: 'ambiguous', person_id: 'ann', score: 0.7, runner_up: 0.69 }

function face(
  personId: string | undefined,
  confidence: IdentityConfidence,
  score = 0.62,
  extra: Partial<FaceClaim> = {},
): FaceClaim {
  return {
    ...(personId ? { person_id: personId } : {}),
    track_id: 'track-1',
    confidence,
    score,
    is_near: true,
    speaking: true,
    ...extra,
  }
}

describe('fusing a voice and a face', () => {
  it('calls it both when the two agree, and multiplies the evidence', () => {
    const fused = fuse(voiceMatch('ann'), 'confirmed', face('ann', 'confirmed'))

    expect(fused).toMatchObject({
      status: 'matched',
      person_id: 'ann',
      source: 'both',
      confidence: 'confirmed',
      harvest_voice: false,
      reinforce: true,
    })
    const voiceAlone = calibratedProbability(0.78, VOICE_CALIBRATION)
    expect(fused.status === 'matched' && fused.probability).toBeGreaterThan(voiceAlone)
  })

  /**
   * The case the harvest exists for: we know the face, the voice is nobody we
   * have a print for, and the speech is thick enough to become one.
   */
  it('takes the face when the voice names nobody, and offers to learn the voice', () => {
    const fused = fuse(NO_VOICE, 'provisional', face('ben', 'confirmed'))

    expect(fused).toMatchObject({
      status: 'matched',
      person_id: 'ben',
      source: 'face',
      confidence: 'confirmed',
      harvest_voice: true,
      reinforce: false,
    })
  })

  it('does not offer to learn a voice from speech too thin to have a tier', () => {
    const fused = fuse(NO_VOICE, 'pending', face('ben', 'confirmed'))

    expect(fused).toMatchObject({ status: 'matched', source: 'face', harvest_voice: false })
  })

  it('leaves a voice-only match exactly as the voice decided it', () => {
    for (const tier of ['provisional', 'confirmed'] as const) {
      const fused = fuse(voiceMatch('ann'), tier)

      expect(fused).toMatchObject({
        status: 'matched',
        person_id: 'ann',
        voiceprint_id: 'print-ann',
        source: 'voice',
        confidence: tier,
        reinforce: tier === 'confirmed',
      })
    }
  })

  it('ignores a face that has not held long enough to be confirmed', () => {
    const fused = fuse(NO_VOICE, 'confirmed', face('ben', 'provisional'))

    expect(fused).toEqual({ status: 'unmatched', reason: 'no_match', voice_score: NO_VOICE.score })
  })

  it('ignores a confirmed track that matched nobody', () => {
    const fused = fuse(voiceMatch('ann'), 'confirmed', face(undefined, 'confirmed'))

    expect(fused).toMatchObject({ source: 'voice', person_id: 'ann' })
  })

  it('carries an ambiguous voice through as ambiguous, not as nobody', () => {
    expect(fuse(AMBIGUOUS, 'confirmed')).toEqual({
      status: 'unmatched',
      reason: 'ambiguous',
      voice_score: AMBIGUOUS.score,
    })
  })

  /**
   * Two confident identifiers naming different people is a question for the
   * owner. Picking a winner here would file one person's sentences under the
   * other's name and there would be nothing left to notice it by.
   */
  it('refuses to resolve two confident identifiers that disagree', () => {
    const fused = fuse(voiceMatch('ann', 0.8), 'confirmed', face('ben', 'confirmed', 0.7))

    expect(fused).toEqual({
      status: 'conflict',
      face_person_id: 'ben',
      voice_person_id: 'ann',
      face_score: 0.7,
      voice_score: 0.8,
    })
  })

  it('lets a confirmed face beat a voice that was only guessing, without reinforcing it', () => {
    const fused = fuse(voiceMatch('ann'), 'provisional', face('ben', 'confirmed'))

    expect(fused).toMatchObject({
      status: 'matched',
      person_id: 'ben',
      source: 'face',
      confidence: 'confirmed',
      reinforce: false,
      harvest_voice: false,
    })
  })
})

describe('combining calibrated probabilities', () => {
  it('is monotonic in the face score once the two agree', () => {
    const probabilities = [0.5, 0.6, 0.7, 0.8].map((score) => {
      const fused = fuse(voiceMatch('ann'), 'confirmed', face('ann', 'confirmed', score))
      return fused.status === 'matched' ? fused.probability : Number.NaN
    })

    for (let i = 1; i < probabilities.length; i += 1) {
      expect(probabilities[i]).toBeGreaterThan(probabilities[i - 1])
    }
  })

  it('leaves the other side alone when one identifier is uninformative', () => {
    expect(fuseProbabilities(0.9, 0.5)).toBeCloseTo(0.9, 12)
    expect(fuseProbabilities(0.5, 0.2)).toBeCloseTo(0.2, 12)
  })

  it('stays a probability at the extremes instead of returning NaN', () => {
    expect(fuseProbabilities(1, 0)).toBeGreaterThanOrEqual(0)
    expect(fuseProbabilities(0, 0)).toBeLessThanOrEqual(1)
  })

  /** The calibrations are anchored so p = 0.5 falls on each accept threshold. */
  it('treats a face exactly on its threshold as no evidence either way', () => {
    expect(calibratedProbability(FACE_MATCH_THRESHOLD, FACE_CALIBRATION)).toBeCloseTo(0.5, 6)
  })
})
