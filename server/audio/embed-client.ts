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
  // Copy into a standalone ArrayBuffer sized to exactly these samples; a
  // Uint8Array view trips over the DOM/node BodyInit type split.
  const payload = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer
  const response = await fetch(`${SIDECAR_URL()}/embed`, {
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
  return { vector: body.vector, duration_ms: body.duration_ms }
}
