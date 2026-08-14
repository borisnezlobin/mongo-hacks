/**
 * Lane E — Mentra Live glasses as a capture and playback surface.
 *
 * Stretch lane. The phone is the golden path; nothing here is required for the
 * demo, and the glasses never lead the pitch.
 *
 * Capture:  glasses mic → MentraOS cloud → onAudioChunk → GlassesUplink →
 *           Lane A's /stream WebSocket → identical StreamBuffer path.
 * Playback: Amelia's amelia_audio event → session.audio.speak(text).
 *
 * The MentraOS SDK runs its own Express server (its webhook lives at /webhook
 * on GLASSES_PORT). It is started separately from Amelia's Hono server rather
 * than mounted into it — two frameworks, and the SDK owns its own lifecycle.
 */

import { request as httpRequest } from 'node:http';
import type { Hono } from 'hono';
// TYPE-ONLY: erased at compile time. @mentra/sdk declares a `development`
// export condition pointing at ./src, which is not shipped, so any VALUE
// import here would make `server/index.ts` unresolvable under Vite/vitest.
// The real import is dynamic, inside startGlassesServer.
import type { AppSession } from '@mentra/sdk';
import type { AmeliaEvent, Id, ServerDependencies } from '../../shared/contracts';
import { GlassesUplink } from './uplink';

interface ActiveGlasses {
  session: AppSession;
  uplink: GlassesUplink;
  conversationId: Id;
  chunks: number;
}

/** One entry per connected pair of glasses. */
const active = new Map<string, ActiveGlasses>();

/** Wires one glasses session to Lane A's ingest. Shared by the server class. */
function attachSession(session: AppSession, sessionId: string, userId: string, audioChunk: string): void {
  const conversationId: Id = `glasses-${sessionId}`;
  const uplink = new GlassesUplink({
    conversationId,
    onError: (error) => console.error('[glasses] uplink error:', error.message),
  });
  uplink.connect();

  const entry: ActiveGlasses = { session, uplink, conversationId, chunks: 0 };
  active.set(sessionId, entry);
  console.log(`[glasses] session ${sessionId} (user ${userId}) → conversation ${conversationId}`);

  session.subscribe(audioChunk as Parameters<AppSession['subscribe']>[0]);

  // Chunks arrive many times per second: keep this handler synchronous and
  // cheap. Framing and the socket write happen in the uplink.
  session.events.onAudioChunk((chunk) => {
    entry.chunks++;
    uplink.push(new Float32Array(chunk.arrayBuffer as ArrayBuffer), chunk.sampleRate ?? 16_000);
  });
}

function detachSession(sessionId: string, reason: string): void {
  const entry = active.get(sessionId);
  if (!entry) return;
  console.log(`[glasses] session ${sessionId} ended (${reason}) after ${entry.chunks} chunks`);
  entry.uplink.close();
  active.delete(sessionId);
}

let server: { stop(): Promise<void> } | null = null;
let unsubscribe: (() => void) | null = null;

/**
 * Lane E's register function. Adds the reserved webhook plus status/control
 * routes to Amelia's Hono app, and wires Amelia's spoken replies to the
 * glasses speaker. The MentraOS server itself only starts when configured.
 */
export function registerGlassesRoutes(app: Hono, deps: ServerDependencies): void {
  // Amelia speaks through the glasses. MentraOS TTS is ElevenLabs under the
  // hood, so this extends the ElevenLabs story onto the wearable.
  unsubscribe?.();
  unsubscribe = deps.bus.subscribe((event: AmeliaEvent) => {
    if (event.type !== 'amelia_audio' || !event.text) return;
    for (const [sessionId, entry] of active) {
      // Fire and forget: a dead speaker must not break the phone answer, which
      // is the actual demo path.
      void entry.session.audio
        .speak(event.text)
        .catch((error: unknown) =>
          console.error(`[glasses] speak failed on ${sessionId}:`, error),
        );
    }
  });

  app.get('/glasses/status', (context) =>
    context.json({
      configured: Boolean(process.env.MENTRA_PACKAGE_NAME && process.env.MENTRA_API_KEY),
      running: server !== null,
      sessions: [...active.entries()].map(([sessionId, entry]) => ({
        session_id: sessionId,
        conversation_id: entry.conversationId,
        chunks: entry.chunks,
        uplink_connected: entry.uplink.connected,
      })),
    }),
  );

  // Reserved in ApiContract. The SDK serves its own /webhook on its own port;
  // this exists so a console misconfiguration points somewhere legible instead
  // of 404ing into silence.
  app.post('/glasses/webhook', async (context) => {
    console.warn('[glasses] webhook hit on the Hono server — point the console at GLASSES_PORT/webhook');
    return context.json({ accepted: false, reason: 'wrong port: the MentraOS webhook is served on GLASSES_PORT' }, 421);
  });
}

/**
 * Start the MentraOS app server. Called from startServer only when configured,
 * so an unconfigured checkout runs the golden path untouched.
 */
export async function startGlassesServer(deps: ServerDependencies): Promise<boolean> {
  const packageName = process.env.MENTRA_PACKAGE_NAME;
  const apiKey = process.env.MENTRA_API_KEY;
  if (!packageName || !apiKey) {
    console.log('[glasses] not configured (MENTRA_PACKAGE_NAME / MENTRA_API_KEY unset) — skipping');
    return false;
  }

  const port = Number(process.env.GLASSES_PORT ?? 7010);

  // Dynamic so the SDK is only resolved when the lane is actually enabled —
  // see the type-only import note at the top of this file.
  const { AppServer, StreamType } = await import('@mentra/sdk');

  class AmeliaGlassesServer extends AppServer {
    protected override async onSession(
      session: AppSession,
      sessionId: string,
      userId: string,
    ): Promise<void> {
      attachSession(session, sessionId, userId, StreamType.AUDIO_CHUNK);
    }

    protected override async onStop(
      sessionId: string,
      _userId: string,
      reason: string,
    ): Promise<void> {
      detachSession(sessionId, reason);
    }
  }

  const instance = new AmeliaGlassesServer({ packageName, apiKey, port });

  // ---- /api proxy → Amelia's Hono server ----------------------------------
  // A free ngrok account gets exactly ONE public URL, and the MentraOS webhook
  // has to own it. Without this, nothing off-network can reach Amelia's API:
  // venue Wi-Fi isolates clients so the phone cannot see the host, and an
  // iPhone hotspot blocks Atlas (the resolver cannot answer the SRV lookup
  // mongodb+srv:// needs, and the carrier drops TCP 27017). Re-using the one
  // tunnel for both is what breaks that deadlock.
  //
  // Hand-rolled rather than http-proxy-middleware: SSE is the whole point and
  // the usual proxies buffer it. Piping raw keeps /events streaming.
  instance.getExpressApp().use('/api', (request: any, response: any) => {
    const upstreamPort = Number(process.env.PORT ?? 3000);

    // The SDK mounts a JSON body parser globally, so by the time this runs the
    // request stream is already drained. Piping it forwards zero bytes while
    // content-length still promises some, and Hono kills the socket ("socket
    // hang up"). Re-serialise the parsed body instead.
    const hasBody = !['GET', 'HEAD'].includes(request.method);
    const body =
      hasBody && request.body && Object.keys(request.body).length > 0
        ? Buffer.from(JSON.stringify(request.body))
        : null;

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers)) {
      // Hop-by-hop and length headers must not survive: the first breaks
      // keep-alive negotiation, the second would describe the ORIGINAL body.
      if (['host', 'connection', 'content-length', 'transfer-encoding'].includes(key)) continue;
      if (typeof value === 'string') headers[key] = value;
    }
    headers.host = `127.0.0.1:${upstreamPort}`;
    if (body) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(body.byteLength);
    }

    const proxied = httpRequest(
      { host: '127.0.0.1', port: upstreamPort, path: request.url, method: request.method, headers },
      (upstream) => {
        response.writeHead(upstream.statusCode ?? 502, upstream.headers);
        // flushHeaders so an SSE client gets the response head immediately
        // instead of waiting for a buffer to fill.
        response.flushHeaders?.();
        upstream.pipe(response);
      },
    );
    proxied.on('error', (error: Error) => {
      console.error('[glasses] /api proxy error:', error.message);
      if (!response.headersSent) response.status(502).json({ error: error.message });
      else response.end();
    });
    // Client hung up mid-stream (SSE reconnects constantly): tear the upstream
    // socket down too, or every phone refresh leaks a subscriber on the bus.
    request.on('close', () => proxied.destroy());

    if (body) proxied.end(body);
    else proxied.end();
  });

  // ---- /api WebSocket upgrades → Amelia's /stream -------------------------
  // The Express middleware above only sees ordinary requests; an upgrade never
  // reaches it, so the phone's mic uplink (wss://…/api/stream) failed with
  // "Audio uplink socket failed to connect" while every HTTP route worked.
  //
  // AppServer exposes no handle on its http.Server, so wrap the Express app's
  // listen() to capture the one it creates. Must be installed BEFORE start().
  const expressApp = instance.getExpressApp() as any;
  const originalListen = expressApp.listen.bind(expressApp);
  expressApp.listen = (...args: unknown[]) => {
    const httpServer = originalListen(...args);
    httpServer.on('upgrade', (request: any, socket: any, head: Buffer) => {
      // Only our prefix. The SDK owns every other upgrade on this server, and
      // stealing one would break its own transport.
      if (!request.url?.startsWith('/api/')) return;

      const upstreamPort = Number(process.env.PORT ?? 3000);
      const headers = { ...request.headers, host: `127.0.0.1:${upstreamPort}` };
      const proxied = httpRequest({
        host: '127.0.0.1',
        port: upstreamPort,
        path: request.url.slice('/api'.length),
        method: request.method,
        headers,
      });

      proxied.on('upgrade', (upstreamResponse: any, upstreamSocket: any, upstreamHead: Buffer) => {
        const statusLine = `HTTP/1.1 ${upstreamResponse.statusCode} ${upstreamResponse.statusMessage}\r\n`;
        const raw = Object.entries(upstreamResponse.headers)
          .map(([key, value]) => `${key}: ${value}\r\n`)
          .join('');
        socket.write(`${statusLine}${raw}\r\n`);
        if (upstreamHead?.length) socket.unshift(upstreamHead);
        // Binary PCM frames in one direction, control frames back.
        upstreamSocket.pipe(socket).pipe(upstreamSocket);
      });

      proxied.on('error', (error: Error) => {
        console.error('[glasses] /api upgrade proxy error:', error.message);
        socket.destroy();
      });
      socket.on('error', () => proxied.destroy());

      if (head?.length) proxied.write(head);
      proxied.end();
    });
    return httpServer;
  };

  await instance.start();
  server = instance;
  console.log(`[glasses] MentraOS app server on :${port} (webhook: /webhook)`);
  return true;
}

export async function stopGlassesServer(): Promise<void> {
  unsubscribe?.();
  unsubscribe = null;
  for (const entry of active.values()) entry.uplink.close();
  active.clear();
  await server?.stop().catch(() => {});
  server = null;
}
