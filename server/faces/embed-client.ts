/**
 * HTTP client for the face half of the Python sidecar. JPEG in, faceprint out.
 *
 * Mirrors server/audio/embed-client.ts deliberately, down to the dimension
 * assertion: a sidecar running a different model is a silent corruption of the
 * print set, because 512 wrong numbers score against 512 right ones perfectly
 * happily.
 */

import { FACEPRINT_DIMS } from '../../shared/contracts'
import { audioConfig } from '../audio/config'

const SIDECAR_URL = () => audioConfig().sidecarUrl

export interface FaceBox {
  x: number
  y: number
  width: number
  height: number
}

export interface FaceEmbedding {
  vector: number[]
  /** Detector confidence in the face behind this vector. */
  det_score: number
  bbox: FaceBox
  elapsed_ms: number
}

export interface DetectedFace {
  bbox: FaceBox
  det_score: number
  /** Five-point landmarks: both eyes, nose, both mouth corners. */
  kps: number[][]
  landmark_2d_106: number[][]
  /** Padded crop, base64 JPEG, longest edge at most FACE_CROP_MAX_PX. */
  crop_jpeg_base64: string
}

/**
 * A sidecar refusal, with the status kept.
 *
 * The face lane has to tell 422 ("that crop holds no face") apart from
 * everything else ("the sidecar is unwell"), because the first is an ordinary
 * answer about one frame and the second must not be reported as one.
 */
export class FaceSidecarError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'FaceSidecarError'
  }
}

/** True when the sidecar looked and found nothing, rather than failing. */
export function isNoFace(error: unknown): boolean {
  return error instanceof FaceSidecarError && error.status === 422
}

/** One face crop -> one L2-normalised faceprint. Throws 422 when there is no face. */
export async function embedFaceJpeg(jpeg: Uint8Array): Promise<FaceEmbedding> {
  const body = (await post('/face/embed', jpeg)) as FaceEmbedding & { dims: number }
  if (body.dims !== FACEPRINT_DIMS) {
    throw new FaceSidecarError(500, `sidecar returned ${body.dims} face dims, expected ${FACEPRINT_DIMS}`)
  }
  return { vector: body.vector, det_score: body.det_score, bbox: body.bbox, elapsed_ms: body.elapsed_ms }
}

/**
 * A whole frame -> every face in it, largest first.
 *
 * The laptop harness only. On the phone this is Apple Vision's job, and the
 * uplink carries crops rather than frames precisely so a conversation on
 * cellular does not cost a megabyte a second.
 */
export async function detectFacesJpeg(jpeg: Uint8Array): Promise<DetectedFace[]> {
  const body = (await post('/face/detect', jpeg)) as { faces: DetectedFace[] }
  return body.faces
}

async function post(path: string, jpeg: Uint8Array): Promise<unknown> {
  const payload = jpeg.buffer.slice(jpeg.byteOffset, jpeg.byteOffset + jpeg.byteLength) as ArrayBuffer
  const response = await fetch(`${SIDECAR_URL()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'image/jpeg' },
    body: payload,
  })
  if (!response.ok) {
    throw new FaceSidecarError(response.status, `sidecar ${path} failed (${response.status}): ${await response.text()}`)
  }
  return response.json()
}
