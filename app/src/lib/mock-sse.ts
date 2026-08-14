import type { AmeliaEvent, Id } from '../../../shared/contracts';
import { UNKNOWN_PERSON_ID, UNKNOWN_VOICEPRINT_ID } from './seed';

/**
 * A scripted stand-in for GET /events. It emits the exact contract payload types the
 * server emits, so the mock and the real stream cannot drift: if this file compiles,
 * the UI is consuming the shipped shapes.
 *
 * The script deliberately exercises every rule the UI has to survive:
 *   - interim then final utterance under one utterance_id (the replacement rule)
 *   - an unknown speaker accumulating turns before anyone names them
 *   - a re-label that moves an already-rendered bubble to a different person
 *   - a fact that supersedes a seeded fact
 *   - a promise carrying fire_at, which schedules a local notification
 *   - an Amelia turn: steps streaming, then spoken reply
 */

export const LIVE_CONVERSATION_ID: Id = 'c-live-demo';

interface ScriptedEvent {
  atMs: number;
  event: AmeliaEvent;
}

const OWNER = 'p-amelia-owner';

export const mockScript: ScriptedEvent[] = [
  {
    atMs: 600,
    event: {
      type: 'utterance', utterance_id: 'lu1', conversation_id: LIVE_CONVERSATION_ID, person_id: OWNER,
      text: 'Maya, is the Oakland place still', start_ms: 0, end_ms: 1800, is_final: false,
    },
  },
  {
    atMs: 1500,
    event: {
      type: 'utterance', utterance_id: 'lu1', conversation_id: LIVE_CONVERSATION_ID, person_id: OWNER,
      text: 'Maya, is the Oakland place still September fifteenth?', start_ms: 0, end_ms: 3100, is_final: true,
    },
  },
  {
    atMs: 3000,
    event: {
      type: 'utterance', utterance_id: 'lu2', conversation_id: LIVE_CONVERSATION_ID, person_id: 'p-maya',
      text: 'It slipped again — September twentieth now.', start_ms: 3400, end_ms: 6200, is_final: true,
    },
  },
  {
    atMs: 4200,
    event: {
      type: 'fact', fact_id: 'f-maya-move-3', person_id: 'p-maya', attribute: 'move_date',
      claim: 'Moving to Oakland on September 20', superseded_fact_id: 'f-maya-move-2',
    },
  },
  {
    atMs: 4500,
    event: {
      type: 'amelia_step', request_id: 'context-f-maya-move-3', step: 'reason',
      message: "Detected a live update to Maya's move date",
    },
  },
  {
    atMs: 4750,
    event: {
      type: 'amelia_step', request_id: 'context-f-maya-move-3', step: 'reason',
      message: 'Current value will drive actions; the previous value stays in history',
    },
  },
  {
    atMs: 4950,
    event: {
      type: 'amelia_step', request_id: 'context-f-maya-move-3', step: 'act',
      message: 'Flagged 1 related open loop for review',
    },
  },
  {
    atMs: 5100,
    event: {
      type: 'amelia_audio', request_id: 'context-f-maya-move-3',
      text: 'That changed: Maya is moving to Oakland on September 20. I found 1 related open loop worth reviewing.',
    },
  },
  {
    atMs: 5600,
    event: {
      type: 'utterance', utterance_id: 'lu3', conversation_id: LIVE_CONVERSATION_ID,
      person_id: UNKNOWN_PERSON_ID, voiceprint_id: UNKNOWN_VOICEPRINT_ID,
      text: "I can help you move, I've got a van that weekend.", start_ms: 6600, end_ms: 9800, is_final: true,
    },
  },
  {
    atMs: 6000,
    event: {
      type: 'identity', conversation_id: LIVE_CONVERSATION_ID, person_id: UNKNOWN_PERSON_ID,
      voiceprint_id: UNKNOWN_VOICEPRINT_ID, name: '', utterance_ids: ['lu3'],
    },
  },
  {
    // Attributed to Jules first — the identity pass corrects it two seconds later.
    atMs: 8200,
    event: {
      type: 'utterance', utterance_id: 'lu4', conversation_id: LIVE_CONVERSATION_ID, person_id: 'p-jules',
      text: 'Rent over there is wild right now, though.', start_ms: 10200, end_ms: 12900, is_final: true,
    },
  },
  {
    atMs: 10400,
    event: {
      type: 'identity', conversation_id: LIVE_CONVERSATION_ID, person_id: 'p-priya',
      name: 'Priya', utterance_ids: ['lu4'],
    },
  },
  {
    atMs: 12000,
    event: {
      type: 'utterance', utterance_id: 'lu5', conversation_id: LIVE_CONVERSATION_ID,
      person_id: UNKNOWN_PERSON_ID, voiceprint_id: UNKNOWN_VOICEPRINT_ID,
      text: "I'll bring flat boxes over tonight, promise.", start_ms: 13400, end_ms: 16400, is_final: true,
    },
  },
  {
    atMs: 13200,
    event: {
      type: 'promise', promise_id: 'pr-live-boxes', person_id: UNKNOWN_PERSON_ID,
      text: 'Bring flat boxes over tonight', due_at: new Date(Date.now() + 120_000).toISOString(), status: 'open',
    },
  },
  {
    atMs: 15000,
    event: {
      type: 'utterance', utterance_id: 'lu6', conversation_id: LIVE_CONVERSATION_ID, person_id: OWNER,
      text: 'Hey Amelia, what should I remember about Maya?', start_ms: 17000, end_ms: 20100, is_final: true,
    },
  },
  { atMs: 15600, event: { type: 'amelia_step', request_id: 'req-live-1', step: 'wake', message: 'Heard "hey Amelia"' } },
  { atMs: 16100, event: { type: 'amelia_step', request_id: 'req-live-1', step: 'authorize', message: 'Voice matches Yan' } },
  { atMs: 16800, event: { type: 'amelia_step', request_id: 'req-live-1', step: 'search', message: "Searching Maya's memory" } },
  { atMs: 17600, event: { type: 'amelia_step', request_id: 'req-live-1', step: 'search', message: 'Found 4 relevant facts' } },
  { atMs: 18400, event: { type: 'amelia_step', request_id: 'req-live-1', step: 'reason', message: 'Resolving newer information' } },
  { atMs: 19200, event: { type: 'amelia_step', request_id: 'req-live-1', step: 'reason', message: 'Move date updated Sep 15 → Sep 20' } },
  { atMs: 20000, event: { type: 'amelia_step', request_id: 'req-live-1', step: 'reply', message: 'Drafting an answer' } },
  {
    atMs: 21200,
    event: {
      type: 'amelia_audio', request_id: 'req-live-1',
      text: 'Maya moves to Oakland on September 20 — that moved from the 15th tonight. She loves Ethiopian food, and someone in this room just offered her a van.',
      mime_type: 'audio/mpeg',
    },
  },
];

export interface MockStreamOptions {
  /** 1 is realtime; raise it to rehearse the demo faster. */
  speed?: number;
  loop?: boolean;
}

export interface MockStreamHandle {
  stop(): void;
}

export function startMockStream(
  onEvent: (event: AmeliaEvent) => void,
  options: MockStreamOptions = {},
): MockStreamHandle {
  const speed = options.speed && options.speed > 0 ? options.speed : 1;
  const timers: ReturnType<typeof setTimeout>[] = [];
  let stopped = false;

  const schedule = (offsetMs: number) => {
    for (const item of mockScript) {
      timers.push(setTimeout(() => {
        if (!stopped) onEvent(item.event);
      }, offsetMs + item.atMs / speed));
    }
    if (options.loop) {
      const cycle = mockScript[mockScript.length - 1].atMs / speed + 4000;
      timers.push(setTimeout(() => {
        if (!stopped) schedule(0);
      }, offsetMs + cycle));
    }
  };

  schedule(0);

  return {
    stop() {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      timers.length = 0;
    },
  };
}
