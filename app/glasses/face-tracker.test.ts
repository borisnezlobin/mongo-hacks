import { describe, expect, it } from 'vitest';
import { FaceTracker, intersectionOverUnion } from './face-tracker';
import type { VisionFace } from './vision';

const face = (x: number, y: number, size: number): VisionFace => ({
  bbox: { x, y, width: size, height: size },
});

describe('face tracker', () => {
  it('keeps one id for a face that drifts across frames', () => {
    const tracker = new FaceTracker();
    const first = tracker.update([face(0.4, 0.4, 0.3)], 0);
    const second = tracker.update([face(0.42, 0.41, 0.3)], 200);
    expect(second[0].track_id).toBe(first[0].track_id);
    expect(second[0].frames).toBe(2);
  });

  it('gives a new id to a face that does not overlap', () => {
    const tracker = new FaceTracker();
    const first = tracker.update([face(0.05, 0.05, 0.2)], 0);
    const second = tracker.update([face(0.7, 0.7, 0.2)], 200);
    expect(second[0].track_id).not.toBe(first[0].track_id);
  });

  it('associates two faces to their own tracks rather than swapping them', () => {
    const tracker = new FaceTracker();
    const started = tracker.update([face(0.05, 0.4, 0.25), face(0.6, 0.4, 0.25)], 0);
    const next = tracker.update([face(0.62, 0.41, 0.25), face(0.07, 0.42, 0.25)], 200);
    expect(next.map((track) => track.track_id).sort())
      .toEqual(started.map((track) => track.track_id).sort());
    const left = next.find((track) => track.bbox.x < 0.3);
    expect(left?.track_id).toBe(started[0].track_id);
  });

  it('forgets a track that has been gone longer than lostAfterMs', () => {
    const tracker = new FaceTracker({ lostAfterMs: 1_000 });
    const first = tracker.update([face(0.4, 0.4, 0.3)], 0);
    tracker.update([], 500);
    expect(tracker.live).toHaveLength(1);
    const back = tracker.update([face(0.4, 0.4, 0.3)], 2_000);
    expect(back[0].track_id).not.toBe(first[0].track_id);
  });

  /** Near is the whole companion rule, so it is decided here and nowhere else. */
  it('marks a track near only when the box is tall enough', () => {
    const tracker = new FaceTracker();
    expect(tracker.update([face(0.4, 0.4, 0.05)], 0)[0].is_near).toBe(false);
    expect(tracker.update([face(0.1, 0.1, 0.4)], 0)[0].is_near).toBe(true);
  });

  it('scores overlap between zero and one', () => {
    const box = { x: 0, y: 0, width: 1, height: 1 };
    expect(intersectionOverUnion(box, box)).toBe(1);
    expect(intersectionOverUnion(box, { x: 2, y: 2, width: 1, height: 1 })).toBe(0);
  });
});
