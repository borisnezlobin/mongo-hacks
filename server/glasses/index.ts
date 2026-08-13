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

  // The console derives a webview URL from the Server URL, and the phone app
  // opens it when the user taps the app. Amelia has no webview, so that 404s
  // and surfaces as "cannot GET /webview" on the phone — alarming, but
  // unrelated to audio. Serve a small live status page instead.
  instance.getExpressApp().get('/webview', (_request: unknown, response: { type(t: string): { send(body: string): void } }) => {
    const sessions = [...active.values()];
    const chunks = sessions.reduce((total, entry) => total + entry.chunks, 0);
    response.type('html').send(`<!doctype html>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{margin:0;padding:2rem;background:#f4f1ea;color:#1c1a18;
       font:16px/1.5 Georgia,'Times New Roman',serif}
  h1{font-size:1.5rem;margin:0 0 .25rem}
  p{margin:.25rem 0;color:#5a534c}
  .n{font-size:2.5rem;margin:1.5rem 0 0}
</style>
<h1>Amelia</h1>
<p>Listening through your glasses.</p>
<p class="n">${sessions.length ? `${chunks.toLocaleString()}` : '&mdash;'}</p>
<p>${sessions.length ? 'audio chunks received' : 'no active session'}</p>`);
  });

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
