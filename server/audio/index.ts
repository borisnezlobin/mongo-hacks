/**
 * Audio entry: WebSocket ingest and session wiring.
 *
 * Fixture replay used to live here too, behind POST /replay/start. It wrote
 * invented conversations and invented people straight into the real database,
 * which is indistinguishable from capture once it is on screen. Removed: the
 * offline evaluation harness in eval/ measures the pipeline without touching
 * anyone's data.
 */

import type { Server } from 'node:http'
import type { Hono } from 'hono'
import { MongoClient, type Collection } from 'mongodb'
// `ws` is CommonJS, so Node's ESM loader does not expose its named exports and the value
// has to be required outright. ws@8 is pinned in server/package.json deliberately: the
// message handler below relies on the `isBinary` argument, which ws@7 does not pass, and
// Metro pulls ws@7 into the workspace. Types still come through the named import.
import { createRequire } from 'node:module'
import type { RawData, WebSocketServer as WebSocketServerType } from 'ws'
const { WebSocketServer } = createRequire(import.meta.url)('ws') as {
  WebSocketServer: typeof WebSocketServerType
}
import {
  AUDIO_FRAME_BYTES,
  OWNER_ID,
  type Person,
  type ServerDependencies,
  type StreamHandshake,
  type Utterance,
} from '../../shared/contracts'
import type { AmeliaBus } from '../lib/bus'
import { createIdentityService, type IdentityService } from '../identity'
import { embedPcm } from './embed-client'
import { OpenAIRealtimeProvider } from './openai-realtime-provider'
import { OpenRouterProvider } from './openrouter-provider'
import { PyannoteProvider } from './pyannote-provider'
import { titleConversation } from '../memory/title'
import { AudioSession } from './session'
import type { StreamProvider } from './types'

interface AudioDeps {
  bus: AmeliaBus
  identity: IdentityService | null
  utterances: Collection<Utterance> | null
  conversations: Collection<{ _id: string }> | null
  people: Collection<Person> | null
}

let cached: Promise<AudioDeps> | null = null

/**
 * How long to wait for Atlas before giving up and recording without it. Short
 * on purpose: the driver's 30s default means the first spoken word of a session
 * is half a minute old before anything reaches the screen.
 */
const DB_CONNECT_TIMEOUT_MS = 5_000

/**
 * Resolve Mongo-backed dependencies once, lazily.
 *
 * Persistence is optional and always has been — without MONGODB_URI the session
 * runs emit-only. What was not optional, and should have been, is Atlas being
 * *reachable*: a connection failure used to reject, leaving the session null, so
 * every audio frame after it died with the thoroughly misleading "binary frame
 * before hello" and the user saw a recording that produced nothing at all. A
 * dropped database costs us history and voiceprints. It must not cost us the
 * transcript, which is the part the user is watching.
 *
 * The rejection was also cached, so one failed connect disabled audio for the
 * lifetime of the process. Now a failure degrades this session and is retried
 * on the next one.
 */
async function audioDeps(bus: AmeliaBus): Promise<AudioDeps> {
  const emitOnly = (): AudioDeps => ({ bus, identity: null, utterances: null, conversations: null, people: null })
  cached ??= (async () => {
    const uri = process.env.MONGODB_URI
    if (!uri) {
      console.warn('MONGODB_URI not set: audio sessions run emit-only, identity disabled')
      return emitOnly()
    }
    const client = await new MongoClient(uri, {
      serverSelectionTimeoutMS: DB_CONNECT_TIMEOUT_MS,
    }).connect()
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
    return {
      bus,
      identity,
      utterances: db.collection<Utterance>('utterances'),
      conversations: db.collection<{ _id: string }>('conversations'),
      people: db.collection<Person>('people'),
    }
  })()

  try {
    return await cached
  } catch (error) {
    console.error(
      'Mongo unavailable — recording anyway, but nothing will be saved and speakers ' +
        'cannot be identified. Check the Atlas IP allowlist.',
      (error as Error).message,
    )
    cached = null
    return emitOnly()
  }
}

/**
 * Name the conversation from what was said, once recording stops.
 *
 * Fire-and-forget by design: a failed title is a cosmetic loss, and the socket
 * is already closing. It must never surface as an ingest error.
 */
async function nameConversation(conversationId: string, bus: AmeliaBus): Promise<void> {
  const deps = await audioDeps(bus)
  if (!deps.utterances || !deps.conversations || !deps.people) return
  try {
    const people = await deps.people.find({ owner_id: OWNER_ID }).toArray()
    const names = new Map(people.map((person) => [person._id, person.name]))
    await titleConversation(conversationId, OWNER_ID, {
      utterances: deps.utterances,
      conversations: deps.conversations,
      bus,
      nameFor: (id) => names.get(id),
    })
  } catch (error) {
    console.error(`titling failed for ${conversationId}`, error)
  }
}

/**
 * Provider precedence is explicit, not key-sniffing: AUDIO_PROVIDER picks the
 * spine. `pyannote` uses true diarization + per-segment transcription for orgs
 * without the OpenAI diarize entitlement; `openrouter` is the one-speaker-per-
 * turn batch fallback; default is OpenAI Realtime.
 */
export function liveProvider(env: Record<string, string | undefined> = process.env): StreamProvider {
  const choice = env.AUDIO_PROVIDER ?? 'openai'
  if (choice === 'pyannote') {
    return new PyannoteProvider({
      pyannoteApiKey: env.PYANNOTE_API_KEY ?? '',
      openrouterApiKey: env.OPENROUTER_API_KEY ?? '',
    })
  }
  if (choice === 'openrouter') {
    return new OpenRouterProvider({ apiKey: env.OPENROUTER_API_KEY ?? '' })
  }
  return new OpenAIRealtimeProvider({
    apiKey: env.OPENAI_API_KEY ?? '',
    url: env.OPENAI_REALTIME_URL,
  })
}

async function createSession(conversationId: string, bus: AmeliaBus): Promise<AudioSession> {
  const deps = await audioDeps(bus)
  // Sessions wrote utterances but never a conversation document, so GET /conversations
  // only ever returned the seeded ones and recordings were invisible in the app's list.
  await deps.conversations?.updateOne(
    { _id: conversationId },
    {
      $setOnInsert: {
        owner_id: OWNER_ID,
        started_at: new Date().toISOString(),
        participant_ids: [],
      },
    },
    { upsert: true },
  ).catch(() => {})
  return new AudioSession({
    conversationId,
    bus,
    provider: liveProvider(),
    identity: deps.identity,
    utterances: deps.utterances,
  })
}

export function registerAudioRoutes(app: Hono, deps: ServerDependencies): void {
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
            session = await createSession(hello.conversation_id, deps.bus as AmeliaBus)
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
        if (!session) {
          // Distinguish the client's fault from ours. Session setup failing
          // after a valid hello used to surface as "binary frame before hello",
          // which sent us looking at the uplink's framing for a problem that
          // was really a dead database connection.
          throw new Error(
            helloReceived
              ? 'session setup failed after hello — see the earlier error'
              : 'binary frame before hello',
          )
        }
        await session.pushAudio(pcm)
      })
    })

    socket.on('close', () => {
      enqueue(async () => {
        const finished = session?.conversationId
        await session?.end()
        session = null
        if (finished) await nameConversation(finished, deps.bus as AmeliaBus)
      })
    })
  })
}
