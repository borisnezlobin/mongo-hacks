/**
 * The clock and the joiner for one conversation.
 *
 * Diarisation and transcription arrive from two different services with two
 * different notions of time. Neither is trusted: the sample cursor is the only
 * clock, and every timestamp in the system is milliseconds from stream start.
 * That is what makes replaying a WAV and streaming a live mic
 * indistinguishable downstream.
 *
 * Pure by design — no network, no database — so the join logic is testable
 * without any API key.
 */

import { SAMPLE_RATE, type PendingUtterance, type Segment, type Word } from './types'

/** A word whose midpoint falls outside every known segment. */
export const UNKNOWN_SPEAKER = 'unknown'

export class StreamBuffer {
  /** Monotonic count of audio samples ingested. The only clock. */
  private sampleCursor = 0
  private segments: Segment[] = []
  private words: Word[] = []
  private chunks: Float32Array[] = []

  constructor(readonly conversationId: string) {}

  // Clock

  /** Advance the clock by a chunk of PCM. Returns the stream position in ms. */
  pushAudio(pcm: Float32Array): number {
    this.sampleCursor += pcm.length
    this.chunks.push(pcm)
    return this.elapsedMs
  }

  get elapsedMs(): number {
    return Math.round((this.sampleCursor / SAMPLE_RATE) * 1000)
  }

  // Ingest

  /**
   * Segments are revisable: diarisation refines boundaries as it hears more,
   * so a segment overlapping one we already hold replaces it rather than
   * stacking.
   */
  addSegments(incoming: Segment[]): void {
    for (const segment of incoming) {
      this.segments = this.segments.flatMap((existing) => subtractOverlap(existing, segment))
      this.segments.push({ ...segment })
    }
    this.segments.sort((a, b) => a.start_ms - b.start_ms)
  }

  /** Words are keyed by start time; a re-emitted word replaces the old text. */
  addWords(incoming: Word[]): void {
    for (const word of incoming) {
      const at = this.words.findIndex((w) => w.start_ms === word.start_ms)
      if (at >= 0) this.words[at] = { ...word }
      else this.words.push({ ...word })
    }
    this.words.sort((a, b) => a.start_ms - b.start_ms)
  }

  // Join

  /**
   * Attribute a word to a speaker by midpoint containment. The midpoint,
   * rather than the start, keeps a word that straddles a boundary with
   * whoever said most of it.
   */
  speakerFor(word: Word): string {
    const midpoint = (word.start_ms + word.end_ms) / 2
    const containing = this.segments.find((s) => midpoint >= s.start_ms && midpoint < s.end_ms)
    return containing?.speaker ?? UNKNOWN_SPEAKER
  }

  /**
   * Group consecutive words sharing a speaker into utterances. Recomputed from
   * scratch every call: upstream revisions are meant to change the answer, and
   * this is the only place that is allowed to happen.
   */
  utterances(): PendingUtterance[] {
    const out: PendingUtterance[] = []
    for (const word of this.words) {
      const speaker = this.speakerFor(word)
      const current = out[out.length - 1]
      if (current && current.session_speaker === speaker) {
        current.text += ` ${word.text}`
        current.end_ms = Math.max(current.end_ms, word.end_ms)
      } else {
        out.push({
          session_speaker: speaker,
          text: word.text,
          start_ms: word.start_ms,
          end_ms: word.end_ms,
        })
      }
    }
    return out
  }

  /**
   * Utterances that will not change again — everything ending before the
   * cutoff, which callers keep behind the live edge so a half-heard sentence
   * is never persisted as final.
   */
  finalizedUtterances(cutoffMs: number): PendingUtterance[] {
    return this.utterances().filter((u) => u.end_ms <= cutoffMs)
  }

  // Per-speaker audio, for voiceprint embedding

  /** Total speech attributed to one session speaker. */
  speechMsFor(sessionSpeaker: string): number {
    return this.segments
      .filter((s) => s.speaker === sessionSpeaker)
      .reduce((total, s) => total + (s.end_ms - s.start_ms), 0)
  }

  /** Session speakers with at least minMs of attributed speech. */
  speakersOverFloor(minMs: number): string[] {
    const seen = new Set(this.segments.map((s) => s.speaker))
    return [...seen].filter((speaker) => this.speechMsFor(speaker) >= minMs)
  }

  /**
   * Concatenated PCM for everything one speaker said, sliced from the retained
   * stream by segment boundaries. This is what gets embedded.
   */
  audioFor(sessionSpeaker: string): Float32Array {
    const stream = this.contiguousAudio()
    const pieces = this.segments
      .filter((s) => s.speaker === sessionSpeaker)
      .map((s) => {
        const from = Math.max(0, Math.floor((s.start_ms / 1000) * SAMPLE_RATE))
        const to = Math.min(stream.length, Math.ceil((s.end_ms / 1000) * SAMPLE_RATE))
        return stream.subarray(from, to)
      })
      .filter((piece) => piece.length > 0)
    const merged = new Float32Array(pieces.reduce((n, p) => n + p.length, 0))
    let offset = 0
    for (const piece of pieces) {
      merged.set(piece, offset)
      offset += piece.length
    }
    return merged
  }

  private contiguous: Float32Array | null = null
  private contiguousSamples = 0

  private contiguousAudio(): Float32Array {
    if (!this.contiguous || this.contiguousSamples !== this.sampleCursor) {
      const merged = new Float32Array(this.sampleCursor)
      let offset = 0
      for (const chunk of this.chunks) {
        merged.set(chunk, offset)
        offset += chunk.length
      }
      this.contiguous = merged
      this.contiguousSamples = this.sampleCursor
    }
    return this.contiguous
  }
}

function subtractOverlap(existing: Segment, revision: Segment): Segment[] {
  if (existing.start_ms >= revision.end_ms || revision.start_ms >= existing.end_ms) {
    return [existing]
  }
  const retained: Segment[] = []
  if (existing.start_ms < revision.start_ms) {
    retained.push({ ...existing, end_ms: revision.start_ms })
  }
  if (existing.end_ms > revision.end_ms) {
    retained.push({ ...existing, start_ms: revision.end_ms })
  }
  return retained
}
