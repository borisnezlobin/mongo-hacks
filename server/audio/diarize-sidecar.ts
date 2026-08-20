/**
 * HTTP client for the sidecar's pyannote diarization. Audio in, speaker turns out.
 *
 * This replaced asking the transcription provider who was speaking. That was
 * not a tuning problem: the provider's labels are not speaker-pure over a long
 * chunk, so pooling them produces blends, and blends resemble each other more
 * than a person resembles himself.
 *
 * Measured against landmarks whose speaker the words themselves settle, on the
 * three-minute recording this makes no merges and no splits, and on the
 * 48-minute one it makes no splits — where the chunked path split the owner's
 * own voice across two speakers all night. It does produce three merge
 * verdicts on the long file, all of them from one 800 ms landmark whose window
 * was written down from the segmentation this replaced and straddles a speaker
 * change under whisper's timings; see the note in word-join.measured.test.ts,
 * which is where that is either confirmed or refuted next time.
 *
 * Turns MAY overlap in time. Two people talking at once is a real output here —
 * 776 s of it on that recording — and callers that assume a partition of the
 * timeline will silently mis-handle it. See wordSpeakers in word-join.ts, which
 * gives an overlapped word to the speaker holding most of it and marks it.
 */

import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { audioConfig } from './config'
import { SAMPLE_RATE } from './types'

export interface SpeakerTurn {
  /** Recording-local label, e.g. 'SPEAKER_00'. Stable within one diarization. */
  speaker: string
  start_ms: number
  end_ms: number
}

export interface Diarization {
  turns: SpeakerTurn[]
  speakers: string[]
  /** Time two or more different speakers hold at once. */
  overlapMs: number
  durationMs: number
  /** Wall-clock the sidecar spent, for the speed line in the final-pass report. */
  elapsedMs: number
}

/**
 * How long to wait, as a multiple of the audio's own duration.
 *
 * pyannote runs at about 1.2x realtime on this machine's CPU — a 48-minute
 * recording took 40 minutes — so a budget of four times the audio's duration is
 * a bound on a machine three times slower, not a guess at the typical case. The
 * floor keeps short clips from timing out on model contention alone.
 */
const TIMEOUT_PER_AUDIO_MS = 4
const TIMEOUT_FLOOR_MS = 5 * 60 * 1000

interface DiarizeResponse {
  turns: SpeakerTurn[]
  speakers: string[]
  overlap_ms: number
  duration_ms: number
  elapsed_ms: number
}

/**
 * Posted through node:http rather than fetch, and that is not a style choice.
 *
 * This request holds a socket open for as long as the model takes, which on the
 * owner's 48-minute recording is forty minutes. Node's fetch gives up after
 * five: undici applies a 300 s headers timeout that no AbortSignal or option on
 * the call can raise, so the first real long recording failed with
 * UND_ERR_HEADERS_TIMEOUT while the sidecar was still working perfectly. A
 * request the caller cannot give a deadline to is not a request this can use.
 */
function post(url: string, body: ArrayBuffer, timeoutMs: number, signal?: AbortSignal): Promise<{
  status: number
  text: string
}> {
  const target = new URL(url)
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest

  return new Promise((resolve, reject) => {
    const outgoing = send(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
      },
      (incoming: import('node:http').IncomingMessage) => {
        const chunks: Buffer[] = []
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
        incoming.on('end', () =>
          resolve({ status: incoming.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }),
        )
        incoming.on('error', reject)
      },
    )
    outgoing.setTimeout(timeoutMs, () => outgoing.destroy(new Error(`diarize timed out after ${timeoutMs} ms`)))
    signal?.addEventListener('abort', () => outgoing.destroy(new Error('diarize aborted')))
    outgoing.on('error', reject)
    outgoing.end(Buffer.from(body))
  })
}

export async function diarizeAudio(
  pcm: Float32Array,
  options: { signal?: AbortSignal } = {},
): Promise<Diarization> {
  const durationMs = (pcm.length / SAMPLE_RATE) * 1000
  const response = await post(
    `${audioConfig().sidecarUrl}/diarize`,
    // Sized to exactly these samples, the same way embed-client does it.
    pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer,
    Math.max(TIMEOUT_FLOOR_MS, durationMs * TIMEOUT_PER_AUDIO_MS),
    options.signal,
  )

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`sidecar diarize failed (${response.status}): ${response.text}`)
  }
  const body = JSON.parse(response.text) as DiarizeResponse
  return {
    turns: [...body.turns].sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms),
    speakers: body.speakers,
    overlapMs: body.overlap_ms,
    durationMs: body.duration_ms,
    elapsedMs: body.elapsed_ms,
  }
}
