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
import type { Collection } from 'mongodb'
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
  AUDIO_FRAME_SAMPLES,
  OWNER_CHECK_MIN_MS,
  OWNER_ID,
  type CaptureMode,
  type OwnerCheckResponse,
  type Person,
  type ServerDependencies,
  type StreamHandshake,
  type Utterance,
} from '../../shared/contracts'
import type { AmeliaBus } from '../lib/bus'
import { getStorage } from '../storage'
import { createIdentityService, type IdentityService } from '../identity'
import { faceServiceFor } from '../faces'
import { embedPcm } from './embed-client'
import { OpenAIRealtimeProvider } from './openai-realtime-provider'
import { OpenRouterProvider } from './openrouter-provider'
import { PyannoteProvider } from './pyannote-provider'
import { OWNER_PERSON_ID } from '../amelia/wake'
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
 * Resolve storage-backed dependencies once, lazily.
 *
 * This used to build its own MongoClient, so on any machine that could not
 * reach Atlas it fell back to emit-only and printed "speakers cannot be
 * identified" — which on the owner's campus network is every single time. The
 * transcript survived and identity, the entire point of the product, did not.
 *
 * Matching is exact cosine in this process now, so identity needs a document
 * store and nothing more. `getStorage()` hands back Atlas when it is reachable
 * and a durable local store when it is not, and either satisfies this lane.
 */
async function audioDeps(bus: AmeliaBus): Promise<AudioDeps> {
  const emitOnly = (): AudioDeps => ({ bus, identity: null, utterances: null, conversations: null, people: null })
  cached ??= (async () => {
    const storage = await getStorage()
    const identity: IdentityService = createIdentityService({
      collections: {
        people: storage.collection('people'),
        voiceprints: storage.collection('voiceprints'),
        utterances: storage.collection('utterances'),
        facts: storage.collection('facts'),
        promises: storage.collection('promises'),
      },
      bus,
    })
    return {
      bus,
      identity,
      utterances: storage.collection('utterances') as unknown as Collection<Utterance>,
      conversations: storage.collection('conversations') as unknown as Collection<{ _id: string }>,
      people: storage.collection('people') as unknown as Collection<Person>,
    }
  })()

  try {
    return await cached
  } catch (error) {
    console.error(
      'Storage unavailable — recording anyway, but nothing will be saved and speakers ' +
        'cannot be identified.',
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

/** One 100 ms frame is AUDIO_FRAME_SAMPLES, so the uplink runs at ten of them a second. */
const SAMPLE_RATE_HZ = AUDIO_FRAME_SAMPLES * 10

/**
 * The uplink's PCM, or the reason it is not.
 *
 * Two routes take raw audio bodies in the same wire format and both used to
 * spell this out; the enrollment one had the only length check and the owner
 * check would have grown a second copy of it.
 */
function float32Body(bytes: Uint8Array): { pcm: Float32Array } | { error: string } {
  if (bytes.byteLength === 0 || bytes.byteLength % 4 !== 0) {
    return { error: 'body must be float32 PCM at 16 kHz mono' }
  }
  return { pcm: new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4) }
}

function durationMs(pcm: Float32Array): number {
  return Math.round((pcm.length / SAMPLE_RATE_HZ) * 1000)
}

/**
 * The face lane, when there is one.
 *
 * Never fatal. A phone with no glasses never sends a face observation, and a
 * server that cannot open the face store must still record and identify by
 * voice exactly as it always has.
 */
async function faceEvidence(deps: ServerDependencies) {
  try {
    return await faceServiceFor(deps)
  } catch (error) {
    console.warn('[audio] face evidence unavailable; voice identity is unaffected', error)
    return undefined
  }
}

async function createSession(
  conversationId: string,
  deps: ServerDependencies,
  captureMode?: CaptureMode,
): Promise<AudioSession> {
  const bus = deps.bus as AmeliaBus
  const audio = await audioDeps(bus)
  // Sessions wrote utterances but never a conversation document, so GET /conversations
  // only ever returned the seeded ones and recordings were invisible in the app's list.
  await audio.conversations?.updateOne(
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
    identity: audio.identity,
    utterances: audio.utterances,
    faces: await faceEvidence(deps),
    captureMode,
    ownerPersonId: OWNER_PERSON_ID,
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
    const parsed = float32Body(new Uint8Array(await context.req.arrayBuffer()))
    if ('error' in parsed) return context.json({ error: parsed.error }, 400)
    const embedding = await embedPcm(parsed.pcm)
    const result = await identity.enroll({
      // owner=1 reuses the seeded owner person instead of creating a new one,
      // so venue enrollment upgrades the wake gate from the fixture voiceprint.
      // Taken from wake.ts rather than written out again: when the literal here
      // and the id the wake gate checks drift apart, voice summon compares
      // against a person who does not exist and simply stops working, silently.
      person_id: context.req.query('owner') === '1' ? OWNER_PERSON_ID : undefined,
      name,
      duration_ms: embedding.duration_ms,
      embedding: embedding.vector,
    })
    return context.json(result, 201)
  })

  /**
   * Is this clip the owner talking?
   *
   * The glasses ask before they start recording. In street mode the wearer's
   * own voice is the only thing that may open a conversation, so this is the
   * gate between a pavement full of strangers and a recording — and it is
   * asked of pre-roll audio the phone is holding in memory, never of anything
   * already written down.
   *
   * The loose OWNER_AUTH_THRESHOLD, not the strict attribution one: the
   * question is "is this the owner", not "which of these people is this".
   */
  app.post('/audio/owner-check', async (context) => {
    const parsed = float32Body(new Uint8Array(await context.req.arrayBuffer()))
    if ('error' in parsed) return context.json({ error: parsed.error }, 400)
    const duration = durationMs(parsed.pcm)
    if (duration < OWNER_CHECK_MIN_MS) {
      return context.json({ error: `need >=${OWNER_CHECK_MIN_MS}ms of speech, got ${duration}ms` }, 422)
    }
    const { identity } = await audioDeps(deps.bus as AmeliaBus)
    if (!identity) return context.json({ error: 'identity unavailable: no storage' }, 503)

    const embedding = await embedPcm(parsed.pcm)
    const { authorized, confidence } = await identity.isOwnerVoice(embedding.vector, null)
    const response: OwnerCheckResponse = {
      owner: authorized,
      score: confidence,
      duration_ms: embedding.duration_ms,
    }
    return context.json(response)
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
            session = await createSession(hello.conversation_id, deps, hello.capture_mode)
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
        const finished = session
        await finished?.end()
        session = null
        if (!finished) return
        // The second pass. The retained audio is transcribed by whisper and
        // diarized by pyannote, joined at word level, and the transcript is
        // rebuilt in place under the same utterance ids, so a user still
        // reading it watches the words and the names settle. Failures here are
        // logged, never thrown: the live transcript is already saved and a
        // missing correction must not read as a failed recording.
        const report = await finished.runFinalPass().catch((error) => {
          console.error(`final pass failed for ${finished.conversationId}`, error)
          return null
        })
        if (report?.ran) {
          console.log(
            `final pass on ${finished.conversationId}: ${report.labels.length} speakers, ` +
              `${report.attributedWords ?? 0}/${report.totalWords ?? 0} words attributed, ` +
              `${report.corrected} utterances rewritten, ${report.superseded ?? 0} superseded` +
              (report.reason ? ` — ${report.reason}` : ''),
          )
        }
        await nameConversation(finished.conversationId, deps.bus as AmeliaBus)
      })
    })
  })
}
