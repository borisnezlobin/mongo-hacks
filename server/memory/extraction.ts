import { OWNER_ID } from '../../shared/contracts';
import type { Id } from '../../shared/contracts';
import type { AmeliaBus } from '../lib/bus';
import { runSlowPass, runWindowPass } from './passes';
import { collections } from './db';
import { upsertUtterance } from './store';
import { ConversationWindow } from './window';

/** Utterances arrive faster than extraction runs; one chain per conversation keeps them ordered. */
const chains = new Map<Id, Promise<void>>();
const windows = new Map<Id, ConversationWindow>();
const waitTimers = new Map<Id, ReturnType<typeof setTimeout>>();

/**
 * Extraction used to be one Fireworks call per finalized turn. A 48-minute
 * recording of seven people finalizes about 2,770 turns, 61% of which are three
 * words or fewer, so that is thousands of serialized calls for one conversation
 * — hours of wall clock on a path that is supposed to keep pace with live
 * speech, and it fell over on provider load long before it got there.
 *
 * Now a conversation accumulates turns into a window and extracts the window,
 * so the work is proportional to how much was said rather than to how many
 * times somebody said "yeah". See server/memory/window.ts for the sizing.
 */
const RETRY_DELAY_MS = 750;

/**
 * `extractStructured` already retries provider overload with backoff, so this
 * covers the other half: a storage blip mid-window. Re-running a window is
 * safe because the idempotency index collapses anything already recorded.
 */
async function withOneRetry(work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (first) {
    console.warn('extraction attempt failed, retrying once:', first);
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    await work();
  }
}

function enqueue(conversationId: Id, work: () => Promise<void>): Promise<void> {
  const chain = (chains.get(conversationId) ?? Promise.resolve())
    .then(() => withOneRetry(work))
    .catch((error) => console.error(`extraction failed for ${conversationId}:`, error))
    .finally(() => {
      // Drop the entry once this is the tail of the chain, or every conversation
      // the process ever saw stays pinned in memory by a settled promise.
      if (chains.get(conversationId) === chain) chains.delete(conversationId);
    });
  chains.set(conversationId, chain);
  return chain;
}

function windowFor(conversationId: Id): ConversationWindow {
  const existing = windows.get(conversationId);
  if (existing) return existing;
  const created = new ConversationWindow();
  windows.set(conversationId, created);
  return created;
}

function cancelWaitTimer(conversationId: Id): void {
  const timer = waitTimers.get(conversationId);
  if (!timer) return;
  clearTimeout(timer);
  waitTimers.delete(conversationId);
}

function flushWindow(bus: AmeliaBus, conversationId: Id): Promise<void> {
  cancelWaitTimer(conversationId);
  const utterances = windowFor(conversationId).take();
  if (utterances.length === 0) return Promise.resolve();
  return enqueue(conversationId, () => runWindowPass(bus, utterances).then(() => undefined));
}

/**
 * The window fills either because enough was said or because enough time
 * passed. The timer is what keeps facts appearing *during* a conversation:
 * people talk far slower than a window's worth of text per minute, so without
 * it a quiet stretch would hold a fact back until the budget filled.
 */
function armWaitTimer(bus: AmeliaBus, conversationId: Id, nowMs: number): void {
  if (waitTimers.has(conversationId)) return;
  const remaining = windowFor(conversationId).waitRemainingMs(nowMs);
  if (remaining === undefined) return;
  // The DOM lib is on for the Expo side, so setTimeout is typed as returning a
  // number here even though this only ever runs on Node.
  const timer: ReturnType<typeof setTimeout> & { unref?: () => void } = setTimeout(() => {
    waitTimers.delete(conversationId);
    const window = windowFor(conversationId);
    if (!window.isReady(Date.now())) return;
    void flushWindow(bus, conversationId);
  }, remaining);
  timer.unref?.();
  waitTimers.set(conversationId, timer);
}

/**
 * Lane B consumes finalized turns from the bus rather than from whichever lane
 * produced them, so replay, live audio and `/debug/utterance` all extract alike.
 */
export function registerExtraction(bus: AmeliaBus): () => void {
  return bus.subscribe((event) => {
    if (event.type !== 'utterance' || !event.is_final) return;
    void enqueue(event.conversation_id, async () => {
      await upsertUtterance({
        _id: event.utterance_id,
        owner_id: OWNER_ID,
        conversation_id: event.conversation_id,
        ...(event.person_id ? { person_id: event.person_id } : {}),
        // Carried onto the stored row because extraction reads it from storage,
        // not from the event, and a fact must never be filed against a voice
        // the identity lane has not settled. See admissibleFacts.
        ...(event.identity_confidence ? { identity_confidence: event.identity_confidence } : {}),
        ...(event.voiceprint_id ? { voiceprint_id: event.voiceprint_id } : {}),
        text: event.text,
        start_ms: event.start_ms,
        end_ms: event.end_ms,
        is_final: true,
      });

      const stored = await collections.utterances().findOne({ _id: event.utterance_id });
      if (!stored) return;

      const now = Date.now();
      const window = windowFor(event.conversation_id);
      window.add(stored, now);
      if (window.isReady(now)) {
        void flushWindow(bus, event.conversation_id);
        return;
      }
      armWaitTimer(bus, event.conversation_id, now);
    });
  });
}

/**
 * Extract everything outstanding for a conversation and then re-read the whole
 * of it. Both callers go through the same per-conversation chain so a manual
 * flush cannot race the live windows.
 */
export function flushSlowPass(bus: AmeliaBus, conversationId: Id): Promise<void> {
  cancelWaitTimer(conversationId);
  windowFor(conversationId).clear();
  windows.delete(conversationId);
  return enqueue(conversationId, () => runSlowPass(bus, conversationId));
}
