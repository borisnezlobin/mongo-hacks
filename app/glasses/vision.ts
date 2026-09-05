/**
 * What the phone's face detector has to provide.
 *
 * An interface rather than a module so the native implementation stays
 * swappable: Apple Vision on iOS, ML Kit if that falls through, and a sidecar
 * adapter over POST /face/detect when the pure modules are replayed in Bun.
 * Everything downstream — tracking, active-speaker scoring, uploading — runs
 * against this shape and has never needed a device.
 */

import { FACE_NEAR_MIN_HEIGHT, type FaceObservationRequest } from '../../shared/contracts';

/** Normalised to the frame, top-left origin, as the observation contract wants. */
export type BoundingBox = FaceObservationRequest['bbox'];

export interface NormalizedPoint {
  x: number;
  y: number;
}

/**
 * Lips are two contours, not one: the outer contour moves with expression and
 * the inner one is the opening, which is the only part that tracks speech.
 */
export interface FaceLandmarks {
  leftEye: NormalizedPoint[];
  rightEye: NormalizedPoint[];
  innerLips: NormalizedPoint[];
  outerLips: NormalizedPoint[];
}

export interface VisionFace {
  bbox: BoundingBox;
  roll?: number;
  yaw?: number;
  quality?: number;
  landmarks?: FaceLandmarks;
  /** A padded crop, longest edge at most cropMaxPx. This is what the server sees. */
  cropJpegBase64?: string;
}

export interface AnalyzeFrameOptions {
  cropMaxPx?: number;
  padding?: number;
}

export interface Vision {
  analyzeFrame(jpegBase64: string, options?: AnalyzeFrameOptions): Promise<VisionFace[]>;
}

/** A companion rather than a passer-by: close enough to be talking to the wearer. */
export function isNearFace(bbox: BoundingBox): boolean {
  return bbox.height >= FACE_NEAR_MIN_HEIGHT;
}
