/**
 * Turns names overheard in conversation into suggestions on the bus.
 *
 * People say each other's names constantly, and that is the cheapest
 * enrollment signal there is: on the dorm recording, "Also Josh tomorrow"
 * identifies a voice that no amount of voiceprint matching could have named,
 * because nobody had ever told the system who Josh was.
 *
 * This only proposes. Naming a person is a write the user makes with one tap,
 * never something inferred text performs on its own.
 */

import type { AmeliaEvent, Id } from '../../shared/contracts';
import type { AmeliaBus } from '../lib/bus';
import { NameSuggester } from './index';
import type { NamingTurn } from './types';

/**
 * Minimum wall-clock between drains.
 *
 * A drain re-scores the whole transcript, because a name heard at minute
 * thirty is evidence about a voice first heard at minute two and the scoring
 * is not incremental. That is affordable occasionally and not every few turns:
 * draining every six utterances meant roughly 166 full re-scorings over a
 * 48-minute recording, each one longer than the last, all of it synchronous
 * inside the bus dispatch.
 *
 * Time is the right unit rather than a turn count, because it bounds the work
 * by conversation length instead of by how talkative the room is. Fifteen
 * seconds is well inside the time it takes somebody to notice a suggestion
 * appear, and it holds whether six people are interrupting each other or two
 * are talking slowly.
 */
const DRAIN_INTERVAL_MS = 15_000;

/**
 * A conversation with no traffic for this long is over, whatever the client
 * said. Sessions used to be released only on a `conversation` event carrying
 * `ended_at`, so a crash, a force-quit or a dropped socket leaked an entire
 * transcript for the lifetime of the process.
 */
const SESSION_IDLE_MS = 30 * 60_000;

interface Session {
  suggester: NameSuggester;
  /** Utterance text, kept so turns can be re-ingested once their speaker is known. */
  turns: Map<Id, Omit<NamingTurn, 'speaker'>>;
  /** utterance_id -> the session cluster or person currently credited with it. */
  speakerOf: Map<Id, string>;
  /** speaker -> the real name it already has, so no suggestion is offered for it. */
  namedSpeakers: Map<string, string>;
  personBySpeaker: Map<string, Id>;
  lastDrainAt: number;
  lastSeenAt: number;
  /** A drain already scheduled; the bus must never wait on the scoring pass. */
  draining: boolean;
}

export interface NameSuggestionOptions {
  ownerName?: string;
  ownerSpeaker?: string;
  /** Injected so the drain cadence and idle release are testable without waiting. */
  now?: () => number;
}

export function registerNameSuggestions(
  bus: AmeliaBus,
  options: NameSuggestionOptions = {},
): () => void {
  const sessions = new Map<Id, Session>();
  const now = () => options.now?.() ?? Date.now();

  const releaseIdleSessions = (): void => {
    const cutoff = now() - SESSION_IDLE_MS;
    for (const [id, session] of sessions) {
      if (session.lastSeenAt < cutoff) sessions.delete(id);
    }
  };

  const sessionFor = (conversationId: Id): Session => {
    const existing = sessions.get(conversationId);
    if (existing) return existing;
    const created: Session = {
      suggester: new NameSuggester({
        conversation_id: conversationId,
        owner_name: options.ownerName,
        owner_speaker: options.ownerSpeaker,
      }),
      turns: new Map(),
      speakerOf: new Map(),
      namedSpeakers: new Map(),
      personBySpeaker: new Map(),
      lastDrainAt: 0,
      lastSeenAt: now(),
      draining: false,
    };
    sessions.set(conversationId, created);
    return created;
  };

  /**
   * Re-ingest every turn with the speaker we currently believe said it.
   *
   * Attribution arrives after the text, so a turn is first seen with no
   * speaker at all and is credited to a cluster seconds later. Vocative
   * reasoning depends entirely on who spoke on either side of the address, so
   * a stale speaker map does not merely weaken a suggestion, it aims it at the
   * wrong person.
   */
  const resync = (session: Session): void => {
    const turns: NamingTurn[] = [];
    for (const [id, turn] of session.turns) {
      const speaker = session.speakerOf.get(id);
      if (!speaker) continue;
      turns.push({ ...turn, id, speaker });
    }
    if (turns.length > 0) session.suggester.ingest(turns);
    session.suggester.updateContext({
      named_speakers: Object.fromEntries(session.namedSpeakers),
      person_by_speaker: Object.fromEntries(session.personBySpeaker),
    });
  };

  /**
   * Score and publish. Runs off the bus dispatch, never inside it: this walks
   * the whole transcript, so doing it synchronously made every sixth utterance
   * pay for all the ones before it while live audio waited.
   */
  const drainNow = (session: Session): void => {
    session.draining = false;
    session.lastDrainAt = now();
    resync(session);
    const suggestions = session.suggester.drain();
    for (const suggestion of suggestions) bus.emit(suggestion);
  };

  const scheduleDrain = (session: Session): void => {
    if (session.draining) return;
    session.draining = true;
    queueMicrotask(() => drainNow(session));
  };

  const handle = (event: AmeliaEvent): void => {
    switch (event.type) {
      case 'utterance': {
        if (!event.is_final || !event.text.trim()) return;
        const session = sessionFor(event.conversation_id);
        session.turns.set(event.utterance_id, {
          id: event.utterance_id,
          text: event.text,
          start_ms: event.start_ms,
          end_ms: event.end_ms,
        });
        if (event.person_id) session.speakerOf.set(event.utterance_id, event.person_id);
        session.lastSeenAt = now();
        if (now() - session.lastDrainAt >= DRAIN_INTERVAL_MS) scheduleDrain(session);
        return;
      }
      case 'speaker_pending': {
        const session = sessionFor(event.conversation_id);
        session.lastSeenAt = now();
        for (const id of event.utterance_ids) session.speakerOf.set(id, event.session_speaker);
        return;
      }
      case 'identity': {
        const session = sessionFor(event.conversation_id);
        session.lastSeenAt = now();
        for (const id of event.utterance_ids) session.speakerOf.set(id, event.person_id);
        session.personBySpeaker.set(event.person_id, event.person_id);
        // A voice that already has a real name needs no suggestion. An
        // auto-generated placeholder is exactly the case this feature exists for.
        if (event.name && !/^(unknown|unnamed|speaker)/i.test(event.name)) {
          session.namedSpeakers.set(event.person_id, event.name);
        }
        return;
      }
      case 'conversation': {
        if (!event.ended_at) return;
        const session = sessions.get(event.conversation_id);
        if (!session) return;
        // The last word is the one most likely to name somebody, so the end of
        // a conversation always scores regardless of when the last drain ran.
        drainNow(session);
        sessions.delete(event.conversation_id);
        releaseIdleSessions();
        return;
      }
      default:
    }
  };

  return bus.subscribe(handle);
}
