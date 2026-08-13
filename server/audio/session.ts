/**
 * One live audio session: PCM in, attributed utterances out.
 *
 * Owns a StreamBuffer, feeds providers, periodically finalizes utterances
 * behind the live edge, persists them when Mongo is configured, and triggers
 * voiceprint attribution once a session speaker crosses the embedding floor.
 * The same object serves the live WebSocket and the WAV replay path.
 */

import type { Collection } from 'mongodb'
import { EMBED_MIN_MS, OWNER_ID, type Utterance, type UtteranceEvent } from '../../shared/contracts'
import type { AmeliaBus } from '../lib/bus'
import { embedPcm } from './embed-client'
import { StreamBuffer, UNKNOWN_SPEAKER } from './stream-buffer'
import type { PendingUtterance, StreamProvider } from './types'

/** How far behind the live edge an utterance must be to count as final. */
const HOLDBACK_MS = 1200

export interface AttributionService {
  attributeSpeaker(input: {
    embedding: number[]
    duration_ms: number
    conversation_id: string
    utterance_ids: string[]
  }): Promise<
    | { status: 'pending'; reason: string }
    | { status: 'matched'; person_id: string; voiceprint_id: string; confidence: number }
    | { status: 'created'; person_id: string; voiceprint_id: string }
  >
}

export interface SessionOptions {
  conversationId: string
  bus: AmeliaBus
  provider: StreamProvider
  identity: AttributionService | null
  utterances: Collection<Utterance> | null
  now?: () => Date
}

interface EmittedUtterance {
  utterance_id: string
  session_speaker: string
  person_id?: string
  voiceprint_id?: string
  text: string
  start_ms: number
  end_ms: number
}

export class AudioSession {
  private readonly buffer: StreamBuffer
  /** Keyed by start_ms — the stable identity of an utterance across revisions. */
  private readonly emitted = new Map<number, EmittedUtterance>()
  /** Session speakers resolved to people, and those currently being resolved. */
  private readonly resolved = new Map<string, { person_id: string; voiceprint_id: string }>()
  private readonly resolving = new Set<string>()
  private readonly now: () => Date

  constructor(private readonly options: SessionOptions) {
    this.buffer = new StreamBuffer(options.conversationId)
    this.now = options.now ?? (() => new Date())
    options.provider.onSegments((segments) => this.buffer.addSegments(segments))
    options.provider.onWords((words) => this.buffer.addWords(words))
  }

  get conversationId(): string {
    return this.options.conversationId
  }

  get elapsedMs(): number {
    return this.buffer.elapsedMs
  }

  /** Feed one chunk of float32 PCM. Drives everything else. */
  async pushAudio(pcm: Float32Array): Promise<void> {
    const positionMs = this.buffer.pushAudio(pcm)
    this.options.provider.pushAudio(pcm, positionMs)
    await this.finalize(positionMs - HOLDBACK_MS)
    await this.maybeAttribute()
  }

  /** Flush everything at end of stream, then close the provider. */
  async end(): Promise<void> {
    await this.finalize(Number.POSITIVE_INFINITY)
    await this.maybeAttribute()
    await this.options.provider.close()
  }

  private async finalize(cutoffMs: number): Promise<void> {
    for (const pending of this.buffer.finalizedUtterances(cutoffMs)) {
      if (pending.session_speaker === UNKNOWN_SPEAKER) continue
      const existing = this.emitted.get(pending.start_ms)
      if (existing && existing.text === pending.text && existing.session_speaker === pending.session_speaker) {
        continue
      }
      await this.emitUtterance(pending, existing?.utterance_id)
    }
  }

  private async emitUtterance(pending: PendingUtterance, reuseId?: string): Promise<void> {
    const identity = this.resolved.get(pending.session_speaker)
    const record: EmittedUtterance = {
      utterance_id: reuseId ?? crypto.randomUUID(),
      session_speaker: pending.session_speaker,
      person_id: identity?.person_id,
      voiceprint_id: identity?.voiceprint_id,
      text: pending.text,
      start_ms: pending.start_ms,
      end_ms: pending.end_ms,
    }
    this.emitted.set(pending.start_ms, record)
    await this.persist(record)
    this.emitEvent(record)
  }

  private async persist(record: EmittedUtterance): Promise<void> {
    const collection = this.options.utterances
    if (!collection) return
    const timestamp = this.now().toISOString()
    await collection.updateOne(
      { _id: record.utterance_id },
      {
        $set: {
          owner_id: OWNER_ID,
          conversation_id: this.options.conversationId,
          person_id: record.person_id,
          voiceprint_id: record.voiceprint_id,
          text: record.text,
          start_ms: record.start_ms,
          end_ms: record.end_ms,
          is_final: true,
          updated_at: timestamp,
        },
        $setOnInsert: { created_at: timestamp },
      },
      { upsert: true },
    )
  }

  private emitEvent(record: EmittedUtterance): void {
    const event: UtteranceEvent = {
      type: 'utterance',
      utterance_id: record.utterance_id,
      conversation_id: this.options.conversationId,
      person_id: record.person_id,
      voiceprint_id: record.voiceprint_id,
      text: record.text,
      start_ms: record.start_ms,
      end_ms: record.end_ms,
      is_final: true,
    }
    this.options.bus.emit(event)
  }

  /**
   * Once a session speaker crosses the embedding floor and is not yet
   * resolved, embed their concatenated speech and ask identity to match or
   * create. On resolution, re-emit that speaker's utterances with the person
   * attached — same utterance_id, so clients replace in place.
   */
  private async maybeAttribute(): Promise<void> {
    if (!this.options.identity) return
    for (const speaker of this.buffer.speakersOverFloor(EMBED_MIN_MS)) {
      if (speaker === UNKNOWN_SPEAKER || this.resolved.has(speaker) || this.resolving.has(speaker)) {
        continue
      }
      this.resolving.add(speaker)
      try {
        const speech = this.buffer.audioFor(speaker)
        const embedding = await embedPcm(speech)
        const utteranceIds = [...this.emitted.values()]
          .filter((u) => u.session_speaker === speaker)
          .map((u) => u.utterance_id)
        const result = await this.options.identity.attributeSpeaker({
          embedding: embedding.vector,
          duration_ms: embedding.duration_ms,
          conversation_id: this.options.conversationId,
          utterance_ids: utteranceIds,
        })
        if (result.status === 'matched' || result.status === 'created') {
          this.resolved.set(speaker, {
            person_id: result.person_id,
            voiceprint_id: result.voiceprint_id,
          })
          await this.reEmitFor(speaker)
        }
      } catch (error) {
        // Attribution is retryable on the next chunk; the transcript must not stall.
        console.error(`attribution failed for ${speaker}`, error)
      } finally {
        this.resolving.delete(speaker)
      }
    }
  }

  private async reEmitFor(speaker: string): Promise<void> {
    const identity = this.resolved.get(speaker)
    if (!identity) return
    for (const record of this.emitted.values()) {
      if (record.session_speaker !== speaker || record.person_id === identity.person_id) continue
      record.person_id = identity.person_id
      record.voiceprint_id = identity.voiceprint_id
      await this.persist(record)
      this.emitEvent(record)
    }
  }
}
