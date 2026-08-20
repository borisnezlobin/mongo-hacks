import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { DebugUtteranceRequest, ServerDependencies, UtteranceEvent, Voiceprint } from '../shared/contracts';
import { OWNER_ID } from '../shared/contracts';
import { registerAmeliaRoutes } from './amelia';
import { attachAudioStream, registerAudioRoutes } from './audio';
import { registerGlassesRoutes, startGlassesServer } from './glasses';
import { identityServiceFor, registerIdentityRoutes } from './identity';
import { AmeliaBus } from './lib/bus';
import { createMemoryApi, registerMemoryRoutes } from './memory';
import { registerNameSuggestions } from './naming/register';
import { registerReviewRoutes } from './review';
import { getStorage, initStorage } from './storage';
import { OWNER_PERSON_ID } from './amelia/wake';

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
    // Log the real error, return a generic one. Driver errors carry cluster
    // hostnames and requireEnv errors name secrets; neither belongs in a
    // response body that a phone on a shared network will receive.
    const reference = crypto.randomUUID().slice(0, 8);
    console.error(`[${reference}] ${context.req.method} ${context.req.path}`, error);
    return context.json({ error: 'Something went wrong on the server.', reference }, 500);
  });
  // Reports the storage backend, because `{ok: true}` with a dead database is
  // a lie the app cannot see through — and on this network Atlas is normally
  // unreachable, so "degraded" is information the user genuinely needs.
  app.get('/health', async (context) => {
    const storage = await initStorage().catch((error: unknown) => ({
      driver: 'none' as const,
      degraded: true,
      error: (error as Error).message,
    }));
    return context.json({ ok: true, service: 'amelia', storage });
  });
  app.get('/events', (context) => {
    // A phone that drops off wifi mid-conversation reconnects a few seconds
    // later. Without this it silently misses everything from the gap and the
    // transcript keeps a hole that no reload explains.
    const header = context.req.header('Last-Event-ID');
    const since = Number(context.req.query('since') ?? header ?? 0);
    const resumeFrom = Number.isFinite(since) ? since : 0;
    return new Response(bus.createEventStream(context.req.raw.signal, resumeFrom), {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        // Reverse proxies (Cloudflare tunnels, nginx) buffer responses by default,
        // which holds every event until the stream closes — the app then shows no
        // live transcript at all. This is the conventional opt-out and costs
        // nothing when served directly.
        'X-Accel-Buffering': 'no',
      },
    });
  });
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
  // Lane A already resolved person_id on the utterance, but the wake gate is the
  // LOOSE threshold (OWNER_AUTH_THRESHOLD), not the strict attribution threshold —
  // so we re-score the stored voiceprint against the owner's voiceprints directly.
  const ownerConfidenceFor = createOwnerConfidenceLookup(deps);

  registerAudioRoutes(app, deps);
  registerIdentityRoutes(app, deps);
  registerMemoryRoutes(app, deps);
  registerAmeliaRoutes(app, deps, { ownerConfidenceFor });
  registerGlassesRoutes(app, deps);
  // Local-only transcript review. Serves real speech off this laptop and writes
  // the owner's corrections to a gitignored file; never expose this server.
  registerReviewRoutes(app, deps);
  // Names overheard in the room are the cheapest way an unnamed voice ever
  // becomes a person. Suggestions only; the tap to confirm is what writes.
  registerNameSuggestions(bus, { ownerSpeaker: OWNER_PERSON_ID });
  return { app, deps };
}

/**
 * Is the voice on this utterance the owner's?
 *
 * Cached per voiceprint_id and populated fire-and-forget, because the wake path
 * runs synchronously on the bus and cannot await. The first utterance from a
 * given voiceprint therefore arms the gate and later ones are scored, which is
 * fine: `detectWake` fails closed on `undefined`.
 *
 * This used to re-implement owner scoring against its own MongoClient and a raw
 * `$vectorSearch`, so it required a reachable Atlas cluster and — worse — it
 * drifted away from how attribution scores the very same question. It now asks
 * the one identity service, which centres embeddings on the session mean before
 * comparing.
 */
function createOwnerConfidenceLookup(
  deps: ServerDependencies,
): (utterance: UtteranceEvent) => number | undefined {
  const cache = new Map<string, number>();
  const inFlight = new Set<string>();

  return (utterance) => {
    const voiceprintId = utterance.voiceprint_id;
    if (!voiceprintId) return undefined;
    const cached = cache.get(voiceprintId);
    if (cached !== undefined) return cached;
    if (inFlight.has(voiceprintId)) return undefined;
    inFlight.add(voiceprintId);

    void (async () => {
      try {
        const storage = await getStorage();
        const voiceprint = await storage
          .collection<Voiceprint>('voiceprints')
          .findOne({ _id: voiceprintId, owner_id: OWNER_ID });
        if (!voiceprint?.embedding) return;

        const identity = await identityServiceFor(deps);
        const { confidence } = await identity.isOwnerVoice(
          voiceprint.embedding,
          voiceprint.session_mean ?? null,
        );
        cache.set(voiceprintId, confidence);
      } catch (error) {
        console.warn('[wake] owner confidence lookup failed; gate stays closed', error);
      } finally {
        inFlight.delete(voiceprintId);
      }
    })();

    return undefined;
  };
}

/**
 * Without these a rejected promise anywhere off the request path — the SSE
 * heartbeat, the extraction chain, a provider retry — takes the whole server
 * down mid-conversation, losing the recording in progress.
 */
function guardProcess(): void {
  process.on('unhandledRejection', (reason) => {
    console.error('[fatal-guard] unhandled rejection', reason);
  });
  process.on('uncaughtException', (error) => {
    console.error('[fatal-guard] uncaught exception', error);
  });
}

export function startServer(port = Number(process.env.PORT ?? 3000)) {
  guardProcess();
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
