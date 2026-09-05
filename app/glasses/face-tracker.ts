/**
 * Stable identities for faces across frames, so a person is one track rather
 * than one observation per frame.
 *
 * Greedy IoU association: every detection is matched to the best-overlapping
 * live track, best pair first. That is enough at 5 to 8 fps with one to three
 * faces, and it is deliberately not a Kalman filter — the tracker's only job
 * is to keep the throttle, the active-speaker window and the server's
 * consecutive-frame count pointed at the same person for as long as they are
 * on screen.
 */

import type { Id } from '../../shared/contracts';
import { isNearFace, type BoundingBox, type VisionFace } from './vision';

export interface FaceTrack {
  track_id: Id;
  bbox: BoundingBox;
  face: VisionFace;
  first_seen_ms: number;
  last_seen_ms: number;
  /** Frames this track has been seen in, which is what makes it persistent or churn. */
  frames: number;
  is_near: boolean;
}

export interface FaceTrackerOptions {
  /** A track with no detection for this long is a different person when it returns. */
  lostAfterMs?: number;
  /** Overlap below which two boxes are not the same face. */
  minIou?: number;
}

export const DEFAULT_LOST_AFTER_MS = 1_500;
export const DEFAULT_MIN_IOU = 0.25;

export function intersectionOverUnion(a: BoundingBox, b: BoundingBox): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= left || bottom <= top) return 0;
  const overlap = (right - left) * (bottom - top);
  const union = a.width * a.height + b.width * b.height - overlap;
  return union > 0 ? overlap / union : 0;
}

interface Pairing {
  trackIndex: number;
  faceIndex: number;
  iou: number;
}

function candidatePairs(tracks: FaceTrack[], faces: VisionFace[], minIou: number): Pairing[] {
  const pairs: Pairing[] = [];
  for (let trackIndex = 0; trackIndex < tracks.length; trackIndex += 1) {
    for (let faceIndex = 0; faceIndex < faces.length; faceIndex += 1) {
      const iou = intersectionOverUnion(tracks[trackIndex].bbox, faces[faceIndex].bbox);
      if (iou >= minIou) pairs.push({ trackIndex, faceIndex, iou });
    }
  }
  return pairs.sort((a, b) => b.iou - a.iou);
}

export class FaceTracker {
  private tracks: FaceTrack[] = [];
  private counter = 0;
  private readonly lostAfterMs: number;
  private readonly minIou: number;

  constructor(options: FaceTrackerOptions = {}) {
    this.lostAfterMs = options.lostAfterMs ?? DEFAULT_LOST_AFTER_MS;
    this.minIou = options.minIou ?? DEFAULT_MIN_IOU;
  }

  /** The tracks that were visible in the most recent frame, newest state first. */
  get live(): FaceTrack[] {
    return [...this.tracks];
  }

  reset(): void {
    this.tracks = [];
  }

  /** Folds one frame of detections in and returns the tracks seen in it. */
  update(faces: VisionFace[], nowMs: number): FaceTrack[] {
    this.dropLost(nowMs);
    const takenTracks = new Set<number>();
    const takenFaces = new Set<number>();
    const seen: FaceTrack[] = [];

    for (const pair of candidatePairs(this.tracks, faces, this.minIou)) {
      if (takenTracks.has(pair.trackIndex) || takenFaces.has(pair.faceIndex)) continue;
      takenTracks.add(pair.trackIndex);
      takenFaces.add(pair.faceIndex);
      seen.push(this.extend(this.tracks[pair.trackIndex], faces[pair.faceIndex], nowMs));
    }

    for (let faceIndex = 0; faceIndex < faces.length; faceIndex += 1) {
      if (takenFaces.has(faceIndex)) continue;
      const track = this.mint(faces[faceIndex], nowMs);
      this.tracks.push(track);
      seen.push(track);
    }

    return seen;
  }

  private extend(track: FaceTrack, face: VisionFace, nowMs: number): FaceTrack {
    track.bbox = face.bbox;
    track.face = face;
    track.last_seen_ms = nowMs;
    track.frames += 1;
    track.is_near = isNearFace(face.bbox);
    return track;
  }

  private mint(face: VisionFace, nowMs: number): FaceTrack {
    this.counter += 1;
    return {
      track_id: `t-${this.counter}`,
      bbox: face.bbox,
      face,
      first_seen_ms: nowMs,
      last_seen_ms: nowMs,
      frames: 1,
      is_near: isNearFace(face.bbox),
    };
  }

  private dropLost(nowMs: number): void {
    this.tracks = this.tracks.filter((track) => nowMs - track.last_seen_ms <= this.lostAfterMs);
  }
}
