import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { DebugUtteranceRequest, UtteranceEvent } from '../shared/contracts';
import { registerAmeliaRoutes } from './amelia';
import { registerAudioRoutes } from './audio';
import { registerIdentityRoutes } from './identity';
import { AmeliaBus } from './lib/bus';
import { createMemoryApi, registerMemoryRoutes } from './memory';

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
  return { app, deps };
}

export function startServer(port = Number(process.env.PORT ?? 3000)) {
  const { app } = createApp();
  return serve({ fetch: app.fetch, port }, (info) => {
    console.log(`Amelia listening on http://localhost:${info.port}`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) startServer();
