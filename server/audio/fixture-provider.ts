/**
 * Replays fixtures/transcript.json as if pyannote and a transcription stream
 * were live. Events are released as the sample clock passes them, so the whole
 * downstream path — join, finalization, identity, SSE — runs identically with
 * or without API keys. Used by the REPLAY path and by keyless demos.
 */

import type { Segment, StreamProvider, Word } from './types'

interface FixtureUtterance {
  speaker: string
  text: string
  start_ms: number
  end_ms: number
}

export class FixtureProvider implements StreamProvider {
  private segmentHandler: (segments: Segment[]) => void = () => {}
  private wordHandler: (words: Word[]) => void = () => {}
  private released = 0
  private readonly utterances: FixtureUtterance[]

  constructor(utterances: FixtureUtterance[]) {
    this.utterances = [...utterances].sort((a, b) => a.start_ms - b.start_ms)
  }

  pushAudio(_pcm: Float32Array, positionMs: number): void {
    while (this.released < this.utterances.length) {
      const utterance = this.utterances[this.released]
      // A real diariser only knows a turn once it has heard it end.
      if (utterance.end_ms > positionMs) break
      this.released += 1
      this.segmentHandler([
        { speaker: utterance.speaker, start_ms: utterance.start_ms, end_ms: utterance.end_ms },
      ])
      this.wordHandler(wordsFor(utterance))
    }
  }

  onSegments(handler: (segments: Segment[]) => void): void {
    this.segmentHandler = handler
  }

  onWords(handler: (words: Word[]) => void): void {
    this.wordHandler = handler
  }

  async close(): Promise<void> {}
}

/**
 * The fixture has utterance-level timing only, so spread word timings across
 * the span proportional to word length. Good enough for the midpoint join.
 */
function wordsFor(utterance: FixtureUtterance): Word[] {
  const words = utterance.text.split(/\s+/).filter(Boolean)
  const span = utterance.end_ms - utterance.start_ms
  const totalChars = words.reduce((n, w) => n + w.length, 0)
  let cursor = utterance.start_ms
  return words.map((text) => {
    const width = totalChars > 0 ? (text.length / totalChars) * span : 0
    const word = { text, start_ms: Math.round(cursor), end_ms: Math.round(cursor + width) }
    cursor += width
    return word
  })
}
