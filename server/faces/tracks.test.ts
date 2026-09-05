import { describe, expect, it } from 'vitest'
import { FACE_CONFIRM_FRAMES, FACE_OBSERVATION_INTERVAL_MS, PREROLL_MS } from '../../shared/contracts'
import { FaceTrackLedger, type TrackObservation } from './tracks'

function observation(overrides: Partial<TrackObservation> = {}): TrackObservation {
  return {
    track_id: 't1',
    person_id: 'p-maya',
    score: 0.7,
    frame_ts_ms: 0,
    is_near: true,
    is_active_speaker: false,
    ...overrides,
  }
}

describe('confirming a face over several frames', () => {
  it('holds a match at provisional until it has repeated FACE_CONFIRM_FRAMES times', () => {
    const ledger = new FaceTrackLedger()

    for (let frame = 1; frame < FACE_CONFIRM_FRAMES; frame += 1) {
      ledger.observe('c1', observation({ frame_ts_ms: frame * 1_000 }))
      expect(ledger.confidenceFor('c1', 't1')).toBe('provisional')
    }
    ledger.observe('c1', observation({ frame_ts_ms: FACE_CONFIRM_FRAMES * 1_000 }))

    expect(ledger.confidenceFor('c1', 't1')).toBe('confirmed')
    expect(ledger.consecutiveFor('c1', 't1')).toBe(FACE_CONFIRM_FRAMES)
  })

  it('starts the count again when the matcher changes its mind about who this is', () => {
    const ledger = new FaceTrackLedger()
    for (let frame = 0; frame < FACE_CONFIRM_FRAMES; frame += 1) {
      ledger.observe('c1', observation({ frame_ts_ms: frame * 1_000 }))
    }

    const state = ledger.observe('c1', observation({ person_id: 'p-tarun', frame_ts_ms: 9_000 }))

    expect(state.consecutive).toBe(1)
    expect(ledger.confidenceFor('c1', 't1')).toBe('provisional')
  })

  it('counts unmatched frames separately, so an unknown face can earn a person', () => {
    const ledger = new FaceTrackLedger()

    let state = ledger.observe('c1', observation({ person_id: undefined, score: 0.2 }))
    state = ledger.observe('c1', observation({ person_id: undefined, score: 0.2, frame_ts_ms: 1_000 }))

    expect(state.unmatched).toBe(2)
    expect(state.consecutive).toBe(0)
    expect(ledger.confidenceFor('c1', 't1')).toBe('pending')
  })

  it('does not let two tracks in one frame claim the same person', () => {
    const ledger = new FaceTrackLedger()
    for (let frame = 0; frame < FACE_CONFIRM_FRAMES; frame += 1) {
      ledger.observe('c1', observation({ track_id: 't1', frame_ts_ms: frame * 1_000 }))
    }

    expect(ledger.confirmedElsewhere('c1', 't2')).toEqual(['p-maya'])
    expect(ledger.confirmedElsewhere('c1', 't1')).toEqual([])
  })
})

describe('what the face lane can say about a stretch of audio', () => {
  const speaking = (streamMs: number) =>
    observation({ stream_ms: streamMs, frame_ts_ms: streamMs, is_active_speaker: true })

  it('merges consecutive speaking frames into one segment', () => {
    const ledger = new FaceTrackLedger()
    ledger.observe('c1', speaking(0))
    ledger.observe('c1', speaking(FACE_OBSERVATION_INTERVAL_MS))
    ledger.observe('c1', speaking(4 * FACE_OBSERVATION_INTERVAL_MS))

    expect(ledger.speakingSegmentsFor('c1', 't1')).toEqual([
      { start_ms: 0, end_ms: 2 * FACE_OBSERVATION_INTERVAL_MS },
      { start_ms: 4 * FACE_OBSERVATION_INTERVAL_MS, end_ms: 5 * FACE_OBSERVATION_INTERVAL_MS },
    ])
  })

  it('claims a track that was present over the span, and says whether it was talking', () => {
    const ledger = new FaceTrackLedger()
    for (let frame = 0; frame < FACE_CONFIRM_FRAMES; frame += 1) {
      ledger.observe('c1', speaking(frame * FACE_OBSERVATION_INTERVAL_MS))
    }
    ledger.observe('c1', observation({ track_id: 't2', person_id: 'p-tarun', stream_ms: 0, is_near: false }))

    const claims = ledger.claimsOverlapping('c1', [{ start_ms: 500, end_ms: 1_500 }])

    expect(claims).toEqual([
      { person_id: 'p-maya', track_id: 't1', confidence: 'confirmed', score: 0.7, is_near: true, speaking: true },
      { person_id: 'p-tarun', track_id: 't2', confidence: 'provisional', score: 0.7, is_near: false, speaking: false },
    ])
  })

  it('says nothing about a span no track was in frame for', () => {
    const ledger = new FaceTrackLedger()
    ledger.observe('c1', speaking(0))

    expect(ledger.claimsOverlapping('c1', [{ start_ms: 60_000, end_ms: 62_000 }])).toEqual([])
  })

  it('carries an unrecognised track as a claim with no person', () => {
    const ledger = new FaceTrackLedger()
    ledger.observe('c1', observation({ person_id: undefined, stream_ms: 0, score: 0.1 }))

    const [claim] = ledger.claimsOverlapping('c1', [{ start_ms: 0, end_ms: 1_000 }])

    expect(claim.person_id).toBeUndefined()
    expect(claim.confidence).toBe('pending')
  })
})

describe('the idle bucket', () => {
  it('is never offered to the audio session as evidence about a turn', () => {
    const ledger = new FaceTrackLedger()
    for (let frame = 0; frame < FACE_CONFIRM_FRAMES; frame += 1) {
      ledger.observe(undefined, observation({ stream_ms: 0, frame_ts_ms: frame * 1_000, is_active_speaker: true }))
    }

    expect(ledger.confidenceFor(undefined, 't1')).toBe('confirmed')
    expect(ledger.claimsOverlapping(undefined, [{ start_ms: 0, end_ms: 1_000 }])).toEqual([])
  })

  it('forgets anything older than the pre-roll, so it is not a log of who you looked at', () => {
    const ledger = new FaceTrackLedger()
    ledger.observe(undefined, observation({ track_id: 't-earlier', frame_ts_ms: 0 }))

    ledger.observe(undefined, observation({ track_id: 't-now', frame_ts_ms: PREROLL_MS + 1_000 }))

    expect(ledger.trackFor(undefined, 't-earlier')).toBeUndefined()
    expect(ledger.trackFor(undefined, 't-now')).toBeDefined()
  })

  it('keeps a conversation track separate from an idle one with the same id', () => {
    const ledger = new FaceTrackLedger()
    ledger.observe('c1', observation())

    expect(ledger.consecutiveFor('c1', 't1')).toBe(1)
    expect(ledger.consecutiveFor(undefined, 't1')).toBe(0)
  })
})
