/**
 * Lane D. Registered from server/index.ts as registerAmeliaRoutes(app, deps);
 * that import never needs to change again.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Hono } from 'hono';
import type {
  AmeliaAudioEvent,
  Id,
  ServerDependencies,
  UtteranceEvent,
} from '../../shared/contracts';
import { runAmelia, type AmeliaResult } from './agent';
import { getDraft, listDrafts, sendDraft } from './email';
import { AUDIO_DIR, AUDIO_MIME, speak } from './tts';
import { detectWake } from './wake';
import { registerLiveContextInterventions } from './live-context';
import { createStepper } from './steps';

export interface AmeliaOptions {
  /**
   * Lane A's identity pass. Undefined ⇒ the wake gate fails closed, which is
   * why the press-and-hold route exists.
   */
  ownerConfidenceFor?: (utterance: UtteranceEvent) => number | undefined;
}

/** One run at a time — a second summon mid-answer would interleave step events. */
let inFlight: AbortController | null = null;

async function respond(
  deps: ServerDependencies,
  command: string,
  source: 'voice' | 'manual',
): Promise<AmeliaResult | null> {
  inFlight?.abort();
  const controller = new AbortController();
  inFlight = controller;

  const requestId: Id = crypto.randomUUID();
  // ONE stepper per request, shared with the loop, so the trace returned to the
  // caller is the same trace that went out over the bus.
  const stepper = createStepper(requestId, (event) => deps.bus.emit(event));

  stepper.step(source === 'voice' ? 'wake' : 'authorize', 'Heard the request');
  console.log(`[amelia] (${source}) ${command}`);

  try {
    const result = await runAmelia({
      requestId,
      command,
      memory: deps.memory,
      stepper,
      signal: controller.signal,
    });

    if (result.aborted) return null;
    if (result.refused || result.truncated) return result;

    if (result.text) {
      // Re-check before speaking. runAmelia's abort checks cover the loop, but
      // TTS is a fresh round-trip afterwards — without this a superseded run
      // still emits amelia_audio and the phone plays the stale answer aloud.
      const spoken = await speak(result.text);
      if (controller.signal.aborted) return null;

      const event: AmeliaAudioEvent = {
        type: 'amelia_audio',
        request_id: requestId,
        text: result.text,
        // No key or a failed call ⇒ no audio_url. Lane C still renders the
        // text, so the answer survives a dead ElevenLabs.
        audio_url: spoken?.audio_url,
        mime_type: spoken ? AUDIO_MIME : undefined,
      };
      deps.bus.emit(event);
    }
    return result;
  } catch (error) {
    if (controller.signal.aborted) return null;
    const detail = error instanceof Error ? error.message : String(error);
    console.error('[amelia] failed:', detail);
    stepper.step('error', detail);
    throw error;
  } finally {
    if (inFlight === controller) inFlight = null;
  }
}

export function registerAmeliaRoutes(
  app: Hono,
  deps: ServerDependencies,
  options: AmeliaOptions = {},
): void {
  // ---- proactive path: explicit live corrections -------------------------
  registerLiveContextInterventions(deps);

  // ---- voice path: wake phrase + owner voiceprint -------------------------
  deps.bus.subscribe((event) => {
    if (event.type !== 'utterance') return;
    const utterance = event as UtteranceEvent;
    if (!utterance.is_final) return;
    const match = detectWake(utterance, options.ownerConfidenceFor?.(utterance));
    if (!match) return;

    // Defer: respond() emits its first step synchronously, and we are still
    // inside bus.emit's dispatch loop. Without this, SSE clients receive the
    // step BEFORE the utterance that triggered it.
    queueMicrotask(() => {
      void respond(deps, match.command, 'voice').catch(() => {});
    });
  });

  // ---- press-and-hold manual summon ---------------------------------------
  // REQUIRED by the plan: the stage net for a failed owner voice match.
  // Deliberately skips the voiceprint gate — holding the phone IS the auth.
  app.post('/amelia/summon', async (context) => {
    const body = await context.req
      .json<{ text?: string }>()
      .catch(() => ({}) as { text?: string });
    const text = body.text?.trim();
    if (!text) return context.json({ error: 'text is required' }, 400);

    const result = await respond(deps, text, 'manual');
    if (!result) return context.json({ error: 'superseded by a newer summon' }, 409);
    if (result.truncated) {
      return context.json({ ...result, error: 'reply truncated before completion' }, 503);
    }
    return context.json(result);
  });

  // ---- email: draft in the app, owner taps to send ------------------------
  app.get('/amelia/drafts', (context) => context.json(listDrafts()));

  app.get('/amelia/drafts/:id', (context) => {
    const draft = getDraft(context.req.param('id'));
    return draft ? context.json(draft) : context.json({ error: 'not found' }, 404);
  });

  app.post('/amelia/drafts/:id/send', async (context) => {
    try {
      return context.json(await sendDraft(context.req.param('id')));
    } catch (error) {
      return context.json(
        { error: error instanceof Error ? error.message : String(error) },
        400,
      );
    }
  });

  // ---- spoken replies -----------------------------------------------------
  app.get('/amelia/audio/:file', async (context) => {
    // basename() so a crafted path cannot walk out of AUDIO_DIR.
    const path = join(AUDIO_DIR, basename(context.req.param('file')));
    try {
      const info = await stat(path);
      return new Response(createReadStream(path) as unknown as ReadableStream, {
        headers: { 'Content-Type': AUDIO_MIME, 'Content-Length': String(info.size) },
      });
    } catch {
      return context.json({ error: 'not found' }, 404);
    }
  });
}
