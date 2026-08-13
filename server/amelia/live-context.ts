import type {
  AmeliaAudioEvent,
  FactEvent,
  Id,
  ServerDependencies,
  UtteranceEvent,
} from '../../shared/contracts';
import { AUDIO_MIME, speak, type SpokenReply } from './tts';

const DEFAULT_COOLDOWN_MS = 10_000;
const DEFAULT_CORRECTION_WINDOW_MS = 30_000;
const MAX_SEEN_FACTS = 500;

/** Spoken interventions stay narrow; sensitive or subjective attributes update silently. */
const ACTIONABLE_ATTRIBUTES = new Set([
  'location',
  'move',
  'move_date',
  'job',
  'employer',
  'project',
  'travel',
]);

const EXPLICIT_CHANGE_CUE = /\b(?:actually|instead|changed?|pushed|moved|rescheduled|no longer|not anymore|now|rather than|correction)\b/i;

export interface LiveContextOptions {
  now?: () => number;
  cooldownMs?: number;
  correctionWindowMs?: number;
  speakImpl?: (text: string) => Promise<SpokenReply | null>;
}

interface RecentCorrection {
  at: number;
  utteranceId: Id;
}

export function hasExplicitChangeCue(text: string): boolean {
  return EXPLICIT_CHANGE_CUE.test(text);
}

export function liveContextReply(claim: string): string {
  const clean = claim.trim().replace(/[.!?]+$/, '');
  return `That changed: ${clean}.`;
}

function humanize(attribute: string): string {
  return attribute.replace(/_/g, ' ');
}

/**
 * A supersession alone is not enough to interrupt the room: a scheduled slow
 * pass can discover old changes. The preceding finalized turn must contain an
 * explicit correction cue from the same attributed person, within a short
 * window. This makes speech a high-confidence live behavior while every fact
 * still reaches the UI and database.
 */
export function registerLiveContextInterventions(
  deps: ServerDependencies,
  options: LiveContextOptions = {},
): () => void {
  if (process.env.AMELIA_LIVE_CONTEXT === '0') return () => {};

  const now = options.now ?? Date.now;
  const cooldownMs = options.cooldownMs ?? Number(process.env.AMELIA_LIVE_CONTEXT_COOLDOWN_MS ?? DEFAULT_COOLDOWN_MS);
  const correctionWindowMs = options.correctionWindowMs ?? DEFAULT_CORRECTION_WINDOW_MS;
  const speakImpl = options.speakImpl ?? speak;
  const recentCorrections = new Map<Id, RecentCorrection>();
  const seenFacts = new Set<Id>();
  let lastAnnouncementAt = Number.NEGATIVE_INFINITY;
  let queue = Promise.resolve();

  return deps.bus.subscribe((event) => {
    if (event.type === 'utterance') {
      const utterance = event as UtteranceEvent;
      if (utterance.is_final && utterance.person_id && hasExplicitChangeCue(utterance.text)) {
        recentCorrections.set(utterance.person_id, { at: now(), utteranceId: utterance.utterance_id });
      }
      return;
    }

    if (event.type !== 'fact') return;
    const fact = event as FactEvent;
    if (!fact.superseded_fact_id || !ACTIONABLE_ATTRIBUTES.has(fact.attribute) || seenFacts.has(fact.fact_id)) return;

    const correction = recentCorrections.get(fact.person_id);
    const announcedAt = now();
    if (!correction || announcedAt - correction.at > correctionWindowMs) return;
    if (announcedAt - lastAnnouncementAt < cooldownMs) return;

    seenFacts.add(fact.fact_id);
    if (seenFacts.size > MAX_SEEN_FACTS) seenFacts.delete(seenFacts.values().next().value as Id);
    recentCorrections.delete(fact.person_id);
    lastAnnouncementAt = announcedAt;

    queue = queue.then(async () => {
      const requestId = `context-${fact.fact_id}`;
      const person = await deps.memory.getPerson(fact.person_id).catch(() => null);
      const subject = person?.name.trim() || 'this speaker';
      deps.bus.emit({
        type: 'amelia_step',
        request_id: requestId,
        step: 'reason',
        message: `Detected a live update to ${subject}'s ${humanize(fact.attribute)}`,
      });

      const text = liveContextReply(fact.claim);
      const spoken = await speakImpl(text);
      const audio: AmeliaAudioEvent = {
        type: 'amelia_audio',
        request_id: requestId,
        text,
        audio_url: spoken?.audio_url,
        mime_type: spoken ? AUDIO_MIME : undefined,
      };
      deps.bus.emit(audio);
    }).catch((error) => {
      console.error('[amelia] live context intervention failed:', error);
    });
  });
}
