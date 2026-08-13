import { OWNER_ID, SLOW_PASS_EVERY_N_UTTERANCES } from '../../shared/contracts';
import type { Id } from '../../shared/contracts';
import type { AmeliaBus } from '../lib/bus';
import { runFastPass, runSlowPass } from './passes';
import { collections } from './db';
import { upsertUtterance } from './store';

/** Utterances arrive faster than extraction runs; one chain per conversation keeps them ordered. */
const chains = new Map<Id, Promise<void>>();
const sinceSlowPass = new Map<Id, number>();

function enqueue(conversationId: Id, work: () => Promise<void>): Promise<void> {
  const chain = (chains.get(conversationId) ?? Promise.resolve())
    .then(work)
    .catch((error) => console.error(`extraction failed for ${conversationId}:`, error));
  chains.set(conversationId, chain);
  return chain;
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
        ...(event.voiceprint_id ? { voiceprint_id: event.voiceprint_id } : {}),
        text: event.text,
        start_ms: event.start_ms,
        end_ms: event.end_ms,
        is_final: true,
      });

      const stored = await collections.utterances().findOne({ _id: event.utterance_id });
      if (stored) await runFastPass(bus, stored);

      const pending = (sinceSlowPass.get(event.conversation_id) ?? 0) + 1;
      if (pending < SLOW_PASS_EVERY_N_UTTERANCES) {
        sinceSlowPass.set(event.conversation_id, pending);
        return;
      }
      sinceSlowPass.set(event.conversation_id, 0);
      await runSlowPass(bus, event.conversation_id);
    });
  });
}

/**
 * The fixture transcript is seven turns long, well under the slow-pass interval,
 * and the demo needs supersession on demand. Both callers go through the same
 * per-conversation chain so a manual flush cannot race the live passes.
 */
export function flushSlowPass(bus: AmeliaBus, conversationId: Id): Promise<void> {
  sinceSlowPass.set(conversationId, 0);
  return enqueue(conversationId, () => runSlowPass(bus, conversationId));
}
