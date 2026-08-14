import { describe, expect, it } from 'vitest'
import { OpenAIRealtimeProvider, resampleLinear } from './openai-realtime-provider'
import { liveProvider } from './index'

class FakeSocket {
  readyState = 0
  readonly sent: string[] = []
  readonly listeners = new Map<string, ((...args: any[]) => void)[]>()

  on(event: string, listener: (...args: any[]) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 3
    this.emit('close')
  }

  emit(event: string, ...args: any[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }
}

describe('OpenAI Realtime provider', () => {
  it('requires credentials instead of silently substituting fixture text', () => {
    expect(() => new OpenAIRealtimeProvider({ apiKey: '' })).toThrow('OPENAI_API_KEY')
    expect(() => liveProvider({})).toThrow('OPENAI_API_KEY')
  })

  it('configures transcription, resamples live PCM, and emits timed speaker words', () => {
    const socket = new FakeSocket()
    let connectedUrl = ''
    const provider = new OpenAIRealtimeProvider({
      apiKey: 'test-key',
      socketFactory: (url) => {
        connectedUrl = url
        return socket
      },
    })
    const segments: unknown[] = []
    const words: unknown[] = []
    provider.onSegments((value) => segments.push(...value))
    provider.onWords((value) => words.push(...value))

    socket.emit('open')
    provider.pushAudio(new Float32Array(1600).fill(0.25))
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'conversation.item.input_audio_transcription.segment',
      speaker: 'speaker_1',
      text: 'hello there',
      start: 0.1,
      end: 0.9,
    })))

    const config = JSON.parse(socket.sent[0])
    expect(connectedUrl).toBe('wss://api.openai.com/v1/realtime?intent=transcription')
    expect(config.session.type).toBe('transcription')
    expect(config.session.audio.input.format.rate).toBe(24_000)
    expect(config.session.audio.input.transcription.model).toBe('gpt-4o-transcribe-diarize')
    const append = JSON.parse(socket.sent[1])
    expect(append.type).toBe('input_audio_buffer.append')
    expect(Buffer.from(append.audio, 'base64')).toHaveLength(2400 * 2)
    expect(segments).toEqual([{ speaker: 'speaker_1', start_ms: 100, end_ms: 900 }])
    expect(words).toMatchObject([
      { text: 'hello', start_ms: 100 },
      { text: 'there', end_ms: 900 },
    ])
  })

  /**
   * Streaming models produce text before the sentence ends. Waiting for
   * `completed` threw that away and made every line land a beat after it was
   * said, which is most of what "the transcript feels slow" actually was.
   */
  it('emits partial text from deltas under the label the finished turn will reuse', () => {
    const socket = new FakeSocket()
    const provider = new OpenAIRealtimeProvider({
      apiKey: 'test-key',
      model: 'gpt-4o-transcribe',
      socketFactory: () => socket,
    })
    const segments: { speaker: string }[] = []
    const words: { text: string }[] = []
    provider.onSegments((value) => segments.push(...value))
    provider.onWords((value) => words.push(...value))

    socket.emit('open')
    provider.pushAudio(new Float32Array(1600).fill(0.25))
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'input_audio_buffer.speech_started',
      item_id: 'item-1',
      audio_start_ms: 0,
    })))
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'item-1',
      delta: 'so I was',
    })))

    expect(words.map((w) => w.text)).toEqual(['so', 'I', 'was'])
    const partialLabel = segments.at(-1)!.speaker

    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-1',
      transcript: 'so I was thinking',
    })))

    // Same label, so the finished text revises the draft in place rather than
    // arriving as a second turn from a second speaker.
    expect(segments.at(-1)!.speaker).toBe(partialLabel)
    expect(words.map((w) => w.text).slice(-4)).toEqual(['so', 'I', 'was', 'thinking'])
  })

  /**
   * Regression: every revision of a turn re-times all of its words, so the
   * buffer cannot match them up individually. Tagging each word with its turn
   * is what lets the buffer replace the set. Without it a live transcript came
   * out as "how are you how how doing? how are are I've how just you just".
   */
  it('tags every word with its turn so a revision replaces rather than stacks', () => {
    const socket = new FakeSocket()
    const provider = new OpenAIRealtimeProvider({
      apiKey: 'test-key',
      model: 'gpt-4o-transcribe',
      socketFactory: () => socket,
    })
    const batches: { text: string; turn?: string }[][] = []
    provider.onWords((value) => batches.push(value))

    socket.emit('open')
    provider.pushAudio(new Float32Array(1600).fill(0.25))
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'input_audio_buffer.speech_started', item_id: 'item-1', audio_start_ms: 0,
    })))
    for (const delta of ['how ', 'are ', 'you']) {
      socket.emit('message', Buffer.from(JSON.stringify({
        type: 'conversation.item.input_audio_transcription.delta', item_id: 'item-1', delta,
      })))
    }

    const turns = new Set(batches.flat().map((w) => w.turn))
    expect(turns.size).toBe(1)
    expect([...turns][0]).toBeTruthy()
  })

  it('ignores deltas when the model supplies real diarisation', () => {
    const socket = new FakeSocket()
    const provider = new OpenAIRealtimeProvider({ apiKey: 'test-key', socketFactory: () => socket })
    const words: unknown[] = []
    provider.onWords((value) => words.push(...value))

    socket.emit('open')
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'conversation.item.input_audio_transcription.segment',
      speaker: 'speaker_1', text: 'hello', start: 0, end: 0.5,
    })))
    const afterDiarised = words.length
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'item-1', delta: 'ignored',
    })))

    expect(words).toHaveLength(afterDiarised)
  })

  it('linearly resamples 16 kHz input to 24 kHz', () => {
    expect(resampleLinear(new Float32Array(1600), 16_000, 24_000)).toHaveLength(2400)
  })

  it('waits for the final transcription before closing', async () => {
    const socket = new FakeSocket()
    const provider = new OpenAIRealtimeProvider({
      apiKey: 'test-key',
      socketFactory: () => socket,
    })
    socket.emit('open')
    provider.pushAudio(new Float32Array(1600))

    const closing = provider.close()
    await Promise.resolve()
    expect(JSON.parse(socket.sent.at(-1)!).type).toBe('input_audio_buffer.commit')
    expect(socket.readyState).not.toBe(3)
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'conversation.item.input_audio_transcription.completed',
    })))
    await closing
    expect(socket.readyState).toBe(3)
  })
})
