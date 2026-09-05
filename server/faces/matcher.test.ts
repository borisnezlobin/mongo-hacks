import { describe, expect, it } from 'vitest'
import type { Faceprint } from '../../shared/contracts'
import {
  FACE_MATCH_MARGIN,
  FACE_MATCH_THRESHOLD,
  MAX_FACEPRINTS_PER_PERSON,
  OWNER_ID,
} from '../../shared/contracts'
import { decideFace, scoreFaces, selectWeakestFaceprints } from './matcher'

/** A unit vector pointing `angle` radians off the first axis, in a 512-d space. */
function vectorAt(angle: number): number[] {
  const embedding = new Array<number>(512).fill(0)
  embedding[0] = Math.cos(angle)
  embedding[1] = Math.sin(angle)
  return embedding
}

function faceprint(id: string, personId: string, angle: number, extra: Partial<Faceprint> = {}): Faceprint {
  return {
    _id: id,
    owner_id: OWNER_ID,
    person_id: personId,
    embedding: vectorAt(angle),
    quality: 0.9,
    created_at: '2026-01-01T00:00:00.000Z',
    ...extra,
  }
}

describe('scoring a face against the print set', () => {
  it('keeps a person at their best print rather than their average', () => {
    const prints = [faceprint('f1', 'p-maya', 1.2), faceprint('f2', 'p-maya', 0.02)]

    const [best] = scoreFaces(vectorAt(0), prints)

    expect(best.person_id).toBe('p-maya')
    expect(best.voiceprint_id).toBe('f2')
    expect(best.score).toBeGreaterThan(0.99)
  })

  it('ranks people by their best print, highest first', () => {
    const scores = scoreFaces(vectorAt(0), [faceprint('f1', 'p-far', 1.0), faceprint('f2', 'p-near', 0.1)])

    expect(scores.map((score) => score.person_id)).toEqual(['p-near', 'p-far'])
  })
})

describe('deciding who a face is', () => {
  it('matches a face that clears the threshold with room to spare', () => {
    const decision = decideFace(scoreFaces(vectorAt(0), [faceprint('f1', 'p-maya', 0.05)]))

    expect(decision.status).toBe('matched')
    expect(decision).toMatchObject({ person_id: 'p-maya' })
  })

  it('refuses a face nobody in the set looks like', () => {
    const decision = decideFace(scoreFaces(vectorAt(0), [faceprint('f1', 'p-maya', 1.4)]))

    expect(decision.status).toBe('no_match')
  })

  it('refuses two people who score within the margin of each other', () => {
    // Both well over the threshold, and closer to each other than FACE_MATCH_MARGIN:
    // a face filed under the wrong sibling is wrong forever.
    const twins = [faceprint('f1', 'p-one', 0.05), faceprint('f2', 'p-two', 0.09)]

    const decision = decideFace(scoreFaces(vectorAt(0), twins))

    expect(decision.status).toBe('ambiguous')
    expect(Math.cos(0.05) - Math.cos(0.09)).toBeLessThan(FACE_MATCH_MARGIN)
  })

  it('ignores a person another track in the same frame already holds', () => {
    const prints = [faceprint('f1', 'p-maya', 0.05)]

    const decision = decideFace(scoreFaces(vectorAt(0), prints), { taken: ['p-maya'] })

    expect(decision.status).toBe('no_match')
  })

  it('decides at the face thresholds, not the voice ones', () => {
    // 0.5 is above FACE_MATCH_THRESHOLD and well below ATTRIBUTION_THRESHOLD.
    const angle = Math.acos(0.5)
    expect(0.5).toBeGreaterThan(FACE_MATCH_THRESHOLD)

    expect(decideFace(scoreFaces(vectorAt(0), [faceprint('f1', 'p-maya', angle)])).status).toBe('matched')
  })
})

describe('staying under the faceprint cap', () => {
  const created = (index: number) => `2026-01-0${index}T00:00:00.000Z`

  it('drops the blurriest print first', () => {
    const prints = [
      faceprint('f-sharp', 'p-maya', 0, { quality: 0.95, created_at: created(1) }),
      faceprint('f-blurry', 'p-maya', 0, { quality: 0.42, created_at: created(2) }),
    ]

    expect(selectWeakestFaceprints(prints, 1)).toEqual(['f-blurry'])
  })

  it('never drops a print the owner enrolled, whatever the cap says', () => {
    const prints = [
      faceprint('f-enrolled', 'p-maya', 0, { quality: 0.5, enrolled: true, created_at: created(1) }),
      faceprint('f-auto', 'p-maya', 0, { quality: 0.9, created_at: created(2) }),
    ]

    expect(selectWeakestFaceprints(prints, 1)).toEqual(['f-auto'])
  })

  it('keeps everything while the person is under the cap', () => {
    const prints = Array.from({ length: MAX_FACEPRINTS_PER_PERSON }, (_value, index) =>
      faceprint(`f${index}`, 'p-maya', 0, { quality: 0.5 }),
    )

    expect(selectWeakestFaceprints(prints)).toEqual([])
  })
})
