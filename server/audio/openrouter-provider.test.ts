import { describe, expect, it, vi } from 'vitest'
import { OpenRouterProvider } from './openrouter-provider'
import { SAMPLE_RATE, type Segment, type Word } from './types'

function pcm(ms: number, amplitude: number): Float32Array {
  const samples = new Float32Array(ms * SAMPLE_RATE / 1000)
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = index % 2 === 0 ? amplitude : -amplitude
  }
  return samples
}

function join(...chunks: Float32Array[]): Float32Array {
  const output = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.length
  }
  return output
}

function response(text: string, status = 200): Response {
  return new Response(JSON.stringify({ text, usage: {} }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve = (_value: T): void => {}
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

describe('OpenRouter provider', () => {
  it('splits speech into turns after sustained silence', async () => {
    let requestCount = 0
    const fetchImpl = (async () => response(`turn ${requestCount++}`)) as typeof fetch
    const provider = new OpenRouterProvider({ apiKey: 'test-key', fetchImpl })
    const segments: Segment[] = []
    provider.onSegments((value) => segments.push(...value))

    provider.pushAudio(join(pcm(1200, 0.1), pcm(300, 0), pcm(1200, 0.1)), 0)
    await provider.close()

    expect(requestCount).toBe(2)
    expect(segments).toHaveLength(2)
  })

  it('uses the stream clock and spreads words within uniquely labelled turns', async () => {
    const texts = ['alpha bbbb', 'second turn']
    const requests: { input: RequestInfo | URL; init?: RequestInit }[] = []
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input, init })
      return response(texts[requests.length - 1])
    }) as typeof fetch
    const provider = new OpenRouterProvider({ apiKey: 'test-key', fetchImpl })
    const segments: Segment[] = []
    const words: Word[][] = []
    const emissions: string[] = []
    provider.onSegments((value) => {
      emissions.push(`segment:${value[0].speaker}`)
      segments.push(...value)
    })
    provider.onWords((value) => {
      emissions.push(`words:${value.map((word) => word.text).join(' ')}`)
      words.push(value)
    })

    provider.pushAudio(join(pcm(1000, 0.1), pcm(260, 0), pcm(600, 0.1)), 7000)
    await provider.close()

    expect(segments).toEqual([
      { speaker: 'turn-0', start_ms: 7000, end_ms: 8000 },
      { speaker: 'turn-1', start_ms: 8260, end_ms: 8860 },
    ])
    expect(words[0]).toEqual([
      { text: 'alpha', start_ms: 7000, end_ms: 7556 },
      { text: 'bbbb', start_ms: 7556, end_ms: 8000 },
    ])
    expect(words.map((turn) => turn.map((word) => word.text).join(' '))).toEqual(texts)
    expect(emissions).toEqual([
      'segment:turn-0',
      'words:alpha bbbb',
      'segment:turn-1',
      'words:second turn',
    ])

    expect(requests[0].input).toBe('https://openrouter.ai/api/v1/audio/transcriptions')
    expect(requests[0].init?.headers).toEqual({
      Authorization: 'Bearer test-key',
      'Content-Type': 'application/json',
    })
    const body = JSON.parse(String(requests[0].init?.body)) as {
      model: string
      input_audio: { data: string; format: string }
      language: string
    }
    expect(body).toMatchObject({
      model: 'openai/whisper-large-v3',
      input_audio: { format: 'wav' },
      language: 'en',
    })
    const wav = Buffer.from(body.input_audio.data, 'base64')
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE')
    expect(wav.readUInt16LE(22)).toBe(1)
    expect(wav.readUInt32LE(24)).toBe(16_000)
    expect(wav.readUInt16LE(34)).toBe(16)
    expect(wav.readUInt32LE(40)).toBe(1000 * SAMPLE_RATE / 1000 * 2)
  })

  it('drops one failed turn and continues emitting later turns', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    let requestCount = 0
    const fetchImpl = (async () => {
      requestCount += 1
      return requestCount === 1 ? response('unavailable', 503) : response('recovered')
    }) as typeof fetch
    const provider = new OpenRouterProvider({ apiKey: 'test-key', fetchImpl })
    const segments: Segment[] = []
    const words: Word[] = []
    provider.onSegments((value) => segments.push(...value))
    provider.onWords((value) => words.push(...value))

    provider.pushAudio(join(pcm(1000, 0.1), pcm(260, 0), pcm(600, 0.1)), 0)
    await expect(provider.close()).resolves.toBeUndefined()

    expect(requestCount).toBe(2)
    expect(segments).toEqual([{ speaker: 'turn-1', start_ms: 1260, end_ms: 1860 }])
    expect(words.map((word) => word.text)).toEqual(['recovered'])
    expect(consoleError).toHaveBeenCalledOnce()
    consoleError.mockRestore()
  })

  it('rejects an idempotent close when every request fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchImpl = (async () => {
      throw new Error('bad credentials')
    }) as typeof fetch
    const provider = new OpenRouterProvider({ apiKey: 'test-key', fetchImpl })
    provider.pushAudio(pcm(400, 0.1), 0)

    const firstClose = provider.close()
    const secondClose = provider.close()

    expect(secondClose).toBe(firstClose)
    await expect(firstClose).rejects.toThrow('bad credentials')
    expect(consoleError).toHaveBeenCalledOnce()
    consoleError.mockRestore()
  })

  it('emits turns in stream order when responses finish out of order', async () => {
    const first = deferred<Response>()
    const second = deferred<Response>()
    const pending = [first, second]
    let requestCount = 0
    const fetchImpl = (async () => pending[requestCount++].promise) as typeof fetch
    const provider = new OpenRouterProvider({ apiKey: 'test-key', fetchImpl })
    const emitted: string[] = []
    provider.onSegments((segments) => emitted.push(segments[0].speaker))
    provider.onWords((words) => emitted.push(words.map((word) => word.text).join(' ')))

    provider.pushAudio(join(pcm(1000, 0.1), pcm(260, 0), pcm(600, 0.1)), 0)
    const closing = provider.close()
    expect(requestCount).toBe(2)

    second.resolve(response('second response'))
    await Promise.resolve()
    expect(emitted).toEqual([])
    first.resolve(response('first response'))
    await closing

    expect(emitted).toEqual(['turn-0', 'first response', 'turn-1', 'second response'])
  })

  it('drops speech shorter than the noise floor', async () => {
    const fetchImpl = vi.fn(async () => response('should not run')) as unknown as typeof fetch
    const provider = new OpenRouterProvider({ apiKey: 'test-key', fetchImpl })

    provider.pushAudio(pcm(380, 0.1), 0)
    await provider.close()

    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('trims leading and trailing silence from the uploaded turn', async () => {
    let uploadedWav: Buffer | null = null
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input_audio: { data: string } }
      uploadedWav = Buffer.from(body.input_audio.data, 'base64')
      return response('trimmed')
    }) as typeof fetch
    const provider = new OpenRouterProvider({ apiKey: 'test-key', fetchImpl })
    const segments: Segment[] = []
    provider.onSegments((value) => segments.push(...value))

    provider.pushAudio(join(pcm(200, 0), pcm(1000, 0.1), pcm(260, 0)), 4000)
    await provider.close()

    expect(segments).toEqual([{ speaker: 'turn-0', start_ms: 4200, end_ms: 5200 }])
    expect(uploadedWav).not.toBeNull()
    expect(uploadedWav!.readUInt32LE(40)).toBe(1000 * SAMPLE_RATE / 1000 * 2)
  })

  it('force-cuts a continuous monologue at fifteen seconds', async () => {
    let requestCount = 0
    const fetchImpl = (async () => response(`part ${requestCount++}`)) as typeof fetch
    const provider = new OpenRouterProvider({ apiKey: 'test-key', fetchImpl })
    const segments: Segment[] = []
    provider.onSegments((value) => segments.push(...value))

    provider.pushAudio(pcm(15_600, 0.1), 2500)
    await provider.close()

    expect(segments).toEqual([
      { speaker: 'turn-0', start_ms: 2500, end_ms: 17_500 },
      { speaker: 'turn-1', start_ms: 17_500, end_ms: 18_100 },
    ])
  })

  it('keeps discontinuous push positions out of the same turn', async () => {
    let requestCount = 0
    const fetchImpl = (async () => response(`turn ${requestCount++}`)) as typeof fetch
    const provider = new OpenRouterProvider({ apiKey: 'test-key', fetchImpl })
    const segments: Segment[] = []
    provider.onSegments((value) => segments.push(...value))

    provider.pushAudio(pcm(610, 0.1), 3000)
    provider.pushAudio(pcm(600, 0.1), 5000)
    await provider.close()

    expect(segments).toEqual([
      { speaker: 'turn-0', start_ms: 3000, end_ms: 3610 },
      { speaker: 'turn-1', start_ms: 5000, end_ms: 5600 },
    ])
  })
})
