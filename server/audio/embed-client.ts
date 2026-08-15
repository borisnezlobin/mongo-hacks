/** HTTP client for the Python ECAPA sidecar. PCM in, voiceprint out. */

import { VOICEPRINT_DIMS } from '../../shared/contracts'

const SIDECAR_URL = () => process.env.SIDECAR_URL ?? 'http://127.0.0.1:8099'

export interface Embedding {
  vector: number[]
  duration_ms: number
}

/**
 * Embed a stretch of speech. The sidecar enforces the same 3000 ms floor the
 * caller checks, so a floor violation here is a bug upstream, not a soft
 * failure — let it throw.
 */
export async function embedPcm(pcm: Float32Array): Promise<Embedding> {
  return post('/embed', pcm)
}

/**
 * Embed a clip below the 3000 ms floor, for clustering only.
 *
 * A short embedding is far too noisy to name a person by, but it is perfectly
 * good at the much easier question the clusterer asks: is this the same voice
 * as the one that was talking a moment ago, on the same microphone, in the same
 * room. Never pass one of these to attribution — pass the cluster's pooled
 * audio instead.
 */
export async function embedPcmForClustering(pcm: Float32Array): Promise<Embedding> {
  return post('/embed/unsafe', pcm)
}

async function post(path: string, pcm: Float32Array): Promise<Embedding> {
  // Copy into a standalone ArrayBuffer sized to exactly these samples; a
  // Uint8Array view trips over the DOM/node BodyInit type split.
  const payload = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer
  const response = await fetch(`${SIDECAR_URL()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: payload,
  })
  if (!response.ok) {
    throw new Error(`sidecar embed failed (${response.status}): ${await response.text()}`)
  }
  const body = (await response.json()) as { vector: number[]; dims: number; duration_ms: number }
  if (body.dims !== VOICEPRINT_DIMS) {
    throw new Error(`sidecar returned ${body.dims} dims, expected ${VOICEPRINT_DIMS}`)
  }
  // The sidecar refuses degenerate embeddings, but this process outlives any
  // one sidecar build and a NaN that reaches Atlas is unrecoverable: it stores
  // clean, compares false against everything, and shows up only as attribution
  // getting quietly worse. Cheap to check on the way in, impossible to undo
  // after the write.
  if (!body.vector.every(Number.isFinite)) {
    throw new Error('sidecar returned a non-finite voiceprint')
  }
  return { vector: body.vector, duration_ms: body.duration_ms }
}
