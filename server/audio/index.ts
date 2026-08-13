/**
 * Lane A entry: WebSocket ingest, WAV replay, and session wiring.
 *
 * The live phone uplink and the fixture replay build the same AudioSession;
 * only the provider differs. Real diarisation/transcription providers slot in
 * behind env keys, and the fixture provider carries every keyless demo.
 */

import { readFile } from 'node:fs/promises'
import type { Server } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Hono } from 'hono'
import { MongoClient, type Collection } from 'mongodb'
// `ws` is CommonJS, so Node's ESM loader does not expose its named exports and the value
// has to be required outright. We destructure `Server`, not `WebSocketServer`: package.json
// asks for ws@8 but the hoisted install here is ws@7 (Metro depends on it), and only
// `Server` exists in both majors. Types still come through the named import.
import { createRequire } from 'node:module'
import type { RawData, WebSocketServer as WebSocketServerType } from 'ws'
const { Server: WebSocketServer } = createRequire(import.meta.url)('ws') as {
  Server: typeof WebSocketServerType
}
import {
  AUDIO_FRAME_BYTES,
  type ServerDependencies,
  type StreamHandshake,
  type Utterance,
} from '../../shared/contracts'
import type { AmeliaBus } from '../lib/bus'
import { createIdentityService, type IdentityService } from '../identity'
import { embedPcm } from './embed-client'
import { FixtureProvider } from './fixture-provider'
import { OpenAIRealtimeProvider } from './openai-realtime-provider'
import { AudioSession } from './session'
import { SAMPLE_RATE, type StreamProvider } from './types'

const FRAME_SAMPLES = AUDIO_FRAME_BYTES / 4

interface AudioDeps {
  bus: AmeliaBus
  identity: IdentityService | null
  utterances: Collection<Utterance> | null
}

let cached: Promise<AudioDeps> | null = null

/**
 * Resolve Mongo-backed dependencies once, lazily. Without MONGODB_URI the
 * session still runs — emit-only, nothing persisted — so the fixture demo
 * works before the cluster exists.
 */
async function audioDeps(bus: AmeliaBus): Promise<AudioDeps> {
  cached ??= (async () => {
    const uri = process.env.MONGODB_URI
    if (!uri) {
      console.warn('MONGODB_URI not set: audio sessions run emit-only, identity disabled')
      return { bus, identity: null, utterances: null }
    }
    const client = await new MongoClient(uri).connect()
    const db = client.db()
    const identity: IdentityService = createIdentityService({
      collections: {
        people: db.collection('people'),
        voiceprints: db.collection('voiceprints'),
        utterances: db.collection('utterances'),
        facts: db.collection('facts'),
        promises: db.collection('promises'),
      },
      bus,
    })
    return { bus, identity, utterances: db.collection<Utterance>('utterances') }
  })()
  return cached
}

async function fixtureProvider(): Promise<StreamProvider> {
  const fixture = JSON.parse(
    await readFile(join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/transcript.json'), 'utf8'),
  ) as { utterances: { speaker: string; text: string; start_ms: number; end_ms: number }[] }
  return new FixtureProvider(fixture.utterances)
}

export function liveProvider(env: Record<string, string | undefined> = process.env): StreamProvider {
  return new OpenAIRealtimeProvider({
    apiKey: env.OPENAI_API_KEY ?? '',
    url: env.OPENAI_REALTIME_URL,
  })
}

async function createSession(
  conversationId: string,
  bus: AmeliaBus,
  mode: 'live' | 'fixture',
): Promise<AudioSession> {
  const deps = await audioDeps(bus)
  return new AudioSession({
    conversationId,
    bus,
    provider: mode === 'fixture' ? await fixtureProvider() : liveProvider(),
    identity: deps.identity,
    utterances: deps.utterances,
  })
}

/**
 * Replay the fixture WAV through the identical ingest path as a live socket.
 * paced=true streams in realtime for demos; the default runs as fast as the
 * pipeline drains, for gates and tests.
 */
async function replayFixture(bus: AmeliaBus, paced: boolean): Promise<{ conversation_id: string; utterances_emitted: number }> {
  const wavBytes = await readFile(join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/conversation.wav'))
  const { readWav } = await import('./wav')
  const audio = readWav(wavBytes)
  if (audio.sampleRate !== SAMPLE_RATE) {
    throw new Error(`fixture must be ${SAMPLE_RATE} Hz, got ${audio.sampleRate}`)
  }
  const conversationId = `replay-${Date.now()}`
  const session = await createSession(conversationId, bus, 'fixture')
  const emitted = new Set<string>()
  const unsubscribe = bus.subscribe((event) => {
    if (event.type === 'utterance' && event.conversation_id === conversationId) {
      emitted.add(event.utterance_id)
    }
  })
  try {
    for (let offset = 0; offset < audio.samples.length; offset += FRAME_SAMPLES) {
      const frame = audio.samples.subarray(offset, offset + FRAME_SAMPLES)
      await session.pushAudio(frame)
      if (paced) await new Promise((resolve) => setTimeout(resolve, 100))
    }
    await session.end()
  } finally {
    unsubscribe()
  }
  return { conversation_id: conversationId, utterances_emitted: emitted.size }
}

export function registerAudioRoutes(app: Hono, deps: ServerDependencies): void {
  app.post('/replay/start', async (context) => {
    const paced = context.req.query('paced') === '1'
    const result = await replayFixture(deps.bus as AmeliaBus, paced)
    return context.json(result, 200)
  })

  // Enrollment from raw audio: the 10 second flow. The phone streams PCM
  // (same wire format as /stream) with the name as a query parameter; the
  // sidecar turns it into a voiceprint and identity stores it.
  app.post('/enroll/audio', async (context) => {
    const name = context.req.query('name')
    if (!name) return context.json({ error: 'name query parameter required' }, 400)
    const { identity } = await audioDeps(deps.bus as AmeliaBus)
    if (!identity) return context.json({ error: 'identity unavailable: MONGODB_URI not set' }, 503)
    const body = new Uint8Array(await context.req.arrayBuffer())
    if (body.byteLength === 0 || body.byteLength % 4 !== 0) {
      return context.json({ error: 'body must be float32 PCM at 16 kHz mono' }, 400)
    }
    const pcm = new Float32Array(body.buffer, body.byteOffset, body.byteLength / 4)
    const embedding = await embedPcm(pcm)
    const result = await identity.enroll({
      // owner=1 reuses the seeded owner person instead of creating a new one,
      // so venue enrollment upgrades the wake gate from the fixture voiceprint.
      person_id: context.req.query('owner') === '1' ? 'p-amelia-owner' : undefined,
      name,
      duration_ms: embedding.duration_ms,
      embedding: embedding.vector,
    })
    return context.json(result, 201)
  })
}

/**
 * Attach the /stream WebSocket to the running HTTP server. Called from
 * startServer — the one place that owns the server handle. Framing per
 * contracts: one JSON hello frame, then 6400-byte float32 binary frames.
 */
export function attachAudioStream(server: Server, deps: ServerDependencies): void {
  const wss = new WebSocketServer({ server, path: '/stream' })
  wss.on('connection', (socket) => {
    let session: AudioSession | null = null
    let helloReceived = false
    let queue: Promise<void> = Promise.resolve()
    const enqueue = (operation: () => Promise<void>): void => {
      queue = queue.then(operation).catch((error) => {
        console.error('stream ingest failed', error)
        socket.close(1011, 'ingest failed')
      })
    }

    socket.on('message', (data: RawData, isBinary: boolean) => {
      if (!isBinary) {
        if (helloReceived) return socket.close(1002, 'hello already received')
        helloReceived = true
        try {
          const hello = JSON.parse(data.toString()) as StreamHandshake
          if (!hello.conversation_id) throw new Error('conversation_id missing')
          enqueue(async () => {
            session = await createSession(hello.conversation_id, deps.bus as AmeliaBus, 'live')
          })
        } catch (error) {
          socket.close(1002, `bad hello: ${(error as Error).message}`)
        }
        return
      }
      const buffer = data as Buffer
      if (buffer.byteLength !== AUDIO_FRAME_BYTES) {
        return socket.close(1002, `frames must be ${AUDIO_FRAME_BYTES} bytes`)
      }
      const pcm = new Float32Array(
        buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
      )
      // Frames are serialized through a queue so revisions stay ordered.
      enqueue(async () => {
        if (!session) throw new Error('binary frame before hello')
        await session.pushAudio(pcm)
      })
    })

    socket.on('close', () => {
      enqueue(async () => {
        await session?.end()
        session = null
      })
    })
  })
}
