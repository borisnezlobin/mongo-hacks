import { describe, expect, it } from 'vitest'
import { ATTRIBUTION_THRESHOLD, OWNER_ID, type Person, type Voiceprint } from '../../shared/contracts'
import { mergeCandidates } from './duplicates'

const AT = '2026-02-01T00:00:00.000Z'

function person(id: string, name: string, extra: Partial<Person> = {}): Person {
  return { _id: id, owner_id: OWNER_ID, name, created_at: AT, updated_at: AT, ...extra }
}

function print(id: string, personId: string, embedding: number[], extra: Partial<Voiceprint> = {}): Voiceprint {
  return {
    _id: id,
    owner_id: OWNER_ID,
    person_id: personId,
    embedding,
    duration_ms: 60_000,
    created_at: AT,
    ...extra,
  }
}

describe('proposing duplicates', () => {
  it('surfaces two records whose voices score as the same person', () => {
    const candidates = mergeCandidates(
      [person('a', 'Unnamed voice', { is_unnamed: true }), person('b', 'Unnamed voice', { is_unnamed: true })],
      [print('print-a', 'a', [1, 0]), print('print-b', 'b', [1, 0])],
    )

    expect(candidates).toHaveLength(1)
    expect(candidates[0].score).toBeCloseTo(1)
    expect(candidates[0].sides.map((side) => side.person_id)).toEqual(['a', 'b'])
  })

  it('says nothing about two voices that are merely similar', () => {
    const candidates = mergeCandidates(
      [person('a', 'Unnamed voice', { is_unnamed: true }), person('b', 'Unnamed voice', { is_unnamed: true })],
      [print('print-a', 'a', [1, 0]), print('print-b', 'b', [0.6, 0.8])],
    )
    expect(candidates).toEqual([])
  })

  /**
   * Scored best-of-prints, exactly as attribution scores a person. Taking the
   * mean instead would let one print from a noisy session hide a pair that is
   * obviously the same voice.
   */
  it('scores a pair by its closest pair of prints, not by their average', () => {
    const candidates = mergeCandidates(
      [person('a', 'Unnamed voice', { is_unnamed: true }), person('b', 'Unnamed voice', { is_unnamed: true })],
      [
        print('print-a1', 'a', [1, 0]),
        print('print-a2', 'a', [0, 1]),
        print('print-b', 'b', [1, 0]),
      ],
    )
    expect(candidates).toHaveLength(1)
    expect(candidates[0].score).toBeCloseTo(1)
    expect(candidates[0].sides[0].voiceprint_id === 'print-a1' || candidates[0].sides[1].voiceprint_id === 'print-a1').toBe(true)
  })

  /**
   * The owner naming two voices differently settles them. Asking again would be
   * the product arguing with the one signal it trusts above its own embeddings.
   */
  it('never proposes merging two people the owner has given different names', () => {
    const candidates = mergeCandidates(
      [person('a', 'Jerry'), person('b', 'Tarun')],
      [print('print-a', 'a', [1, 0]), print('print-b', 'b', [1, 0])],
    )
    expect(candidates).toEqual([])
  })

  it('still proposes when only one side has been named', () => {
    const candidates = mergeCandidates(
      [person('a', 'Jerry'), person('b', 'Unnamed voice', { is_unnamed: true })],
      [print('print-a', 'a', [1, 0]), print('print-b', 'b', [1, 0])],
    )
    expect(candidates).toHaveLength(1)
  })

  /** mergePeople keeps the oldest person, so the caller sees that one first. */
  it('puts the person a merge would keep first, and carries the evidence to judge it', () => {
    const candidates = mergeCandidates(
      [
        person('younger', 'Unnamed voice', { is_unnamed: true, created_at: '2026-03-01T00:00:00.000Z' }),
        person('older', 'Unnamed voice', { is_unnamed: true, created_at: '2026-01-01T00:00:00.000Z' }),
      ],
      [
        print('print-younger', 'younger', [1, 0], { duration_ms: 21_000, source_conversation_id: 'c-2' }),
        print('print-older', 'older', [1, 0], { duration_ms: 90_000, source_conversation_id: 'c-1' }),
      ],
    )

    expect(candidates[0].sides[0]).toMatchObject({
      person_id: 'older',
      voiceprint_id: 'print-older',
      duration_ms: 90_000,
      source_conversation_id: 'c-1',
    })
    expect(candidates[0].sides[1]).toMatchObject({ person_id: 'younger', duration_ms: 21_000 })
  })

  it('ranks the most confident pair first and honours a limit', () => {
    const people = ['a', 'b', 'c'].map((id) => person(id, 'Unnamed voice', { is_unnamed: true }))
    const candidates = mergeCandidates(people, [
      print('print-a', 'a', [1, 0, 0]),
      print('print-b', 'b', [1, 0, 0]),
      print('print-c', 'c', [0.95, 0.312, 0]),
    ], { limit: 1 })

    expect(candidates).toHaveLength(1)
    expect(candidates[0].sides.map((side) => side.person_id).sort()).toEqual(['a', 'b'])
  })

  /**
   * The pair this guard exists for. Run over four real conversations without
   * it, the sweep proposed Boris and Tarun at 0.681 — two prints from the same
   * three-minute recording with under a minute of speech behind each. Thin
   * against thin is outside where the zero-false-accept measurement holds.
   */
  it('will not propose a pair when neither side has enough speech behind it', () => {
    const candidates = mergeCandidates(
      [person('a', 'Unnamed voice', { is_unnamed: true }), person('b', 'Unnamed voice', { is_unnamed: true })],
      [
        print('print-a', 'a', [1, 0], { duration_ms: 48_000 }),
        print('print-b', 'b', [1, 0], { duration_ms: 27_000 }),
      ],
    )
    expect(candidates).toEqual([])
  })

  /**
   * A real duplicate always has one record built from a conversation the person
   * actually talked in, so requiring one substantial side costs no recall.
   */
  it('proposes when one side is substantial, however thin the other', () => {
    const candidates = mergeCandidates(
      [person('a', 'Unnamed voice', { is_unnamed: true }), person('b', 'Unnamed voice', { is_unnamed: true })],
      [
        print('print-a', 'a', [1, 0], { duration_ms: 8_000 }),
        print('print-b', 'b', [1, 0], { duration_ms: 500_000 }),
      ],
    )
    expect(candidates).toHaveLength(1)
  })

  it('ignores people with no prints, who cannot be compared at all', () => {
    const candidates = mergeCandidates(
      [person('a', 'Unnamed voice', { is_unnamed: true }), person('b', 'Unnamed voice', { is_unnamed: true })],
      [print('print-a', 'a', [1, 0])],
    )
    expect(candidates).toEqual([])
  })

  it('defaults to the attribution threshold, where no two different people were ever measured', () => {
    const just_below = Math.sqrt(Math.max(0, 1 - (ATTRIBUTION_THRESHOLD - 0.02) ** 2))
    const candidates = mergeCandidates(
      [person('a', 'Unnamed voice', { is_unnamed: true }), person('b', 'Unnamed voice', { is_unnamed: true })],
      [print('print-a', 'a', [1, 0]), print('print-b', 'b', [ATTRIBUTION_THRESHOLD - 0.02, just_below])],
    )
    expect(candidates).toEqual([])
  })
})
