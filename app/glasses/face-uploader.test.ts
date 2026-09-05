import { describe, expect, it } from 'vitest';
import { FACE_OBSERVATION_INTERVAL_MS, type FaceObservationRequest } from '../../shared/contracts';
import { FaceUploader, MAX_IN_FLIGHT, type FaceObservation } from './face-uploader';

function harness(options: { hold?: boolean } = {}) {
  let now = 0;
  const sent: FaceObservationRequest[] = [];
  const resolvers: (() => void)[] = [];
  const uploader = new FaceUploader({
    api: {
      observeFace(request) {
        sent.push(request);
        if (!options.hold) {
          return Promise.resolve({ track_id: request.track_id, decision: 'pending' as const, confidence: 'pending' as const });
        }
        return new Promise((resolve) => {
          resolvers.push(() => resolve({ track_id: request.track_id, decision: 'pending', confidence: 'pending' }));
        });
      },
    },
    now: () => now,
  });
  return {
    uploader,
    sent,
    settleAll: async () => {
      for (const resolve of resolvers.splice(0)) resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
    advance(ms: number) {
      now += ms;
    },
  };
}

const observation = (overrides: Partial<FaceObservation> = {}): FaceObservation => ({
  frame_ts_ms: 0,
  frame_seq: 0,
  track_id: 't-1',
  bbox: { x: 0.2, y: 0.2, width: 0.3, height: 0.3 },
  is_near: true,
  is_active_speaker: false,
  crop_jpeg_base64: 'crop',
  ...overrides,
});

describe('face uploader', () => {
  it('sends a track it has never seen straight away', () => {
    const h = harness();
    expect(h.uploader.observe(observation())).toBe(true);
    expect(h.sent).toHaveLength(1);
  });

  it('throttles a track to one observation per interval', () => {
    const h = harness();
    h.uploader.observe(observation());
    h.advance(FACE_OBSERVATION_INTERVAL_MS - 1);
    expect(h.uploader.observe(observation())).toBe(false);
    h.advance(1);
    expect(h.uploader.observe(observation())).toBe(true);
    expect(h.sent).toHaveLength(2);
  });

  /** Who is talking is the thing the server cannot work out on its own. */
  it('sends immediately when a track starts or stops being the active speaker', () => {
    const h = harness();
    h.uploader.observe(observation());
    h.advance(50);
    expect(h.uploader.observe(observation({ is_active_speaker: true }))).toBe(true);
    h.advance(50);
    expect(h.uploader.observe(observation({ is_active_speaker: true }))).toBe(false);
    h.advance(50);
    expect(h.uploader.observe(observation({ is_active_speaker: false }))).toBe(true);
  });

  it('throttles each track on its own clock', () => {
    const h = harness();
    h.uploader.observe(observation({ track_id: 'a' }));
    expect(h.uploader.observe(observation({ track_id: 'b' }))).toBe(true);
    expect(h.sent.map((request) => request.track_id)).toEqual(['a', 'b']);
  });

  it('drops rather than queues once the uplink is behind', async () => {
    const h = harness({ hold: true });
    for (let index = 0; index < MAX_IN_FLIGHT; index += 1) {
      h.uploader.observe(observation({ track_id: `t-${index}` }));
    }
    expect(h.uploader.inFlight).toBe(MAX_IN_FLIGHT);
    expect(h.uploader.observe(observation({ track_id: 'late' }))).toBe(false);
    expect(h.uploader.dropped).toBe(1);

    await h.settleAll();
    expect(h.uploader.inFlight).toBe(0);
    expect(h.uploader.observe(observation({ track_id: 'late' }))).toBe(true);
  });

  it('sends pre-roll observations past the throttle, with their retroactive stream_ms', () => {
    const h = harness();
    h.uploader.observe(observation({ track_id: 'a' }));
    h.uploader.observeRetroactive([
      observation({ track_id: 'a', stream_ms: 0, conversation_id: 'c-1' }),
      observation({ track_id: 'a', stream_ms: 900, conversation_id: 'c-1' }),
    ]);
    expect(h.sent.map((request) => request.stream_ms)).toEqual([undefined, 0, 900]);
  });

  it('forgetting a track lets its next frame through at once', () => {
    const h = harness();
    h.uploader.observe(observation());
    expect(h.uploader.observe(observation())).toBe(false);
    h.uploader.forget('t-1');
    expect(h.uploader.observe(observation())).toBe(true);
  });
});
