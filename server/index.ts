import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { DebugUtteranceRequest, UtteranceEvent } from '../shared/contracts';
import { registerAmeliaRoutes } from './amelia';
import { attachAudioStream, registerAudioRoutes } from './audio';
import { registerGlassesRoutes, startGlassesServer } from './glasses';
import { registerIdentityRoutes } from './identity';
import { AmeliaBus } from './lib/bus';
import { createMemoryApi, registerMemoryRoutes } from './memory';

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

  registerAudioRoutes(app, deps);
  registerIdentityRoutes(app, deps);
  registerMemoryRoutes(app, deps);
  registerAmeliaRoutes(app, deps);
  registerGlassesRoutes(app, deps);
  return { app, deps };
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
