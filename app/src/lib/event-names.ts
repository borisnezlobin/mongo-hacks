import type { BusEventName } from '../../../shared/contracts';

/**
 * Every event the SSE client subscribes to.
 *
 * Its own file, free of React Native imports, so a test can assert that it
 * covers the bus exhaustively. It did not: `name_suggestion` was missing, and
 * an EventSource only delivers named events it has a listener for, so the
 * propose-a-name flow fired against the mock and never once against a live
 * server. A list maintained by hand beside a union that grows is a bug with a
 * delay on it.
 */
export const EVENT_NAMES: BusEventName[] = [
  'utterance',
  'identity',
  'identity_conflict',
  'presence',
  'speaker_pending',
  'name_suggestion',
  'conversation',
  'fact',
  'promise',
  'amelia_step',
  'amelia_audio',
];
