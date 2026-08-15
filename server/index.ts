import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { MongoClient } from 'mongodb';
import type { DebugUtteranceRequest, Person, Utterance, UtteranceEvent, Voiceprint } from '../shared/contracts';
import { OWNER_ID } from '../shared/contracts';
import { registerAmeliaRoutes } from './amelia';
import { attachAudioStream, registerAudioRoutes } from './audio';
import { registerGlassesRoutes, startGlassesServer } from './glasses';
import { registerIdentityRoutes } from './identity';
import { AmeliaBus } from './lib/bus';
import { createMemoryApi, registerMemoryRoutes } from './memory';
import { rawCosine, voiceprintSearchPipeline } from './identity/service';

/** True when this file is the process entry, including `tsx index.ts` / `tsx watch index.ts`. */
export function isDirectRun(argv: readonly string[] = process.argv, moduleUrl = import.meta.url): boolean {
  const thisFile = fileURLToPath(moduleUrl);
  const thisDir = dirname(thisFile);
  return argv.slice(1).some((arg) => {
    try {
      return resolve(arg) === thisFile || resolve(thisDir, arg) === thisFile;
    } catch {
      return false;
    }
  });
}

export function createApp() {
  const app = new Hono();
  const bus = new AmeliaBus();
  const memory = createMemoryApi({ bus });
  const deps = { bus, memory };

  app.use('*', cors());
  app.onError((error, context) => {
    console.error(error);
    return context.json({ error: error.message }, 500);
  });
  app.get('/health', (context) => context.json({ ok: true, service: 'amelia' }));
  app.get('/events', (context) => new Response(bus.createEventStream(context.req.raw.signal), {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      // Reverse proxies (Cloudflare tunnels, nginx) buffer responses by default, which
      // holds every event until the stream closes — the app then shows no live transcript
      // at all. This is the conventional opt-out and costs nothing when served directly.
      'X-Accel-Buffering': 'no',
    },
  }));
  app.post('/debug/utterance', async (context) => {
    const body = await context.req.json<DebugUtteranceRequest>();
    const event: UtteranceEvent = {
      type: 'utterance',
      utterance_id: body.utterance_id ?? crypto.randomUUID(),
      conversation_id: body.conversation_id,
      person_id: body.person_id,
      voiceprint_id: body.voiceprint_id,
      text: body.text,
      start_ms: body.start_ms,
      end_ms: body.end_ms,
      is_final: body.is_final ?? true,
    };
    bus.emit(event);
    return context.json(event, 202);
  });

  // Voice "Hey Amelia" needs Lane A's confidence that the speaker is the owner.
  // Lane A already resolved person_id on the utterance, but the wake gate is a
  // different threshold from attribution (OWNER_AUTH_THRESHOLD, the stricter one,
  // because a summon authorizes writes) — so we re-score the stored voiceprint
  // against the owner's voiceprints directly.
  const ownerConfidenceFor = createOwnerConfidenceLookup();

  registerAudioRoutes(app, deps);
  registerIdentityRoutes(app, deps);
  registerMemoryRoutes(app, deps);
  registerAmeliaRoutes(app, deps, { ownerConfidenceFor });
  registerGlassesRoutes(app, deps);
  return { app, deps };
}

/**
 * Lazily resolved, cached per voiceprint_id. Returns undefined when identity is
 * unavailable (no MONGODB_URI) so the wake gate fails closed and the
 * press-and-hold summon remains the deliberate bypass.
 */
function createOwnerConfidenceLookup(): (utterance: UtteranceEvent) => number | undefined {
  let client: Promise<MongoClient> | null = null;
  const cache = new Map<string, number>();

  return (utterance) => {
    const voiceprintId = utterance.voiceprint_id;
    if (!voiceprintId) return undefined;
    const cached = cache.get(voiceprintId);
    if (cached !== undefined) return cached;

    if (!process.env.MONGODB_URI) return undefined;
    client ??= new MongoClient(process.env.MONGODB_URI).connect();

    // Fire-and-forget: the wake path is synchronous over the bus, so we cannot
    // await here. The confidence is computed and cached for the NEXT utterance
    // from the same voiceprint; combined with person_id gating in detectWake,
    // the first owner turn arms the gate and subsequent turns are scored.
    void client.then(async (mongo) => {
      try {
        const db = mongo.db();
        const voiceprint = await db
          .collection<Voiceprint>('voiceprints')
          .findOne({ _id: voiceprintId, owner_id: OWNER_ID });
        if (!voiceprint?.embedding) return;

        const owner = await db
          .collection<Person>('people')
          .findOne({ owner_id: OWNER_ID, is_owner: true });
        if (!owner) return;

        const [match] = await db
          .collection<Voiceprint>('voiceprints')
          .aggregate<{ score: number }>([
            {
              $vectorSearch: {
                index: 'voiceprints_vector',
                path: 'embedding',
                queryVector: voiceprint.embedding,
                filter: { owner_id: OWNER_ID, person_id: owner._id },
                numCandidates: 60,
                limit: 1,
              },
            },
            { $project: { score: { $meta: 'vectorSearchScore' } } },
          ])
          .toArray();
        if (match) cache.set(voiceprintId, rawCosine(match.score));
      } catch {
        // A failed lookup leaves the gate closed; the next utterance retries.
      }
    });

    return cache.get(voiceprintId);
  };
}

export function startServer(port = Number(process.env.PORT ?? 3000)) {
  const { app, deps } = createApp();
  const server = serve({ fetch: app.fetch, port }, (info) => {
    console.log(`Amelia listening on http://localhost:${info.port}`);
  });
  // Announced Lane A addition: the /stream WebSocket needs the server handle
  // for its upgrade hook, which only exists here.
  attachAudioStream(server as import('node:http').Server, deps);
  // Announced Lane E addition: the MentraOS SDK runs its own Express server on
  // its own port. No-ops unless MENTRA_PACKAGE_NAME / MENTRA_API_KEY are set,
  // so an unconfigured checkout runs the golden path untouched.
  void startGlassesServer(deps).catch((error: unknown) => {
    console.error('[glasses] failed to start (golden path unaffected):', error);
  });
  return server;
}

if (isDirectRun()) startServer();
