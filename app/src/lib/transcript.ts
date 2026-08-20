import type { Id, Utterance } from '../../../shared/contracts';
import type { PersonRecord } from '../state/reducer';

/**
 * Transcript shaping, kept free of React Native so it can be tested directly.
 */

/**
 * Which person a turn belongs to, or would belong to if someone named it.
 *
 * There were two versions of this: the long-press menu minted `utterance._id` and the
 * header button minted `person_id ?? voiceprint_id ?? 'speaker-'+_id`. Naming the same
 * speaker through both routes produced two different people for one voice.
 */
export function voiceKeyFor(utterance: Utterance, sessionSpeaker?: Id): Id {
  // The diarization cluster comes before the voiceprint deliberately: it is the id the
  // server addresses its name suggestions to, and confirming one has to land on the
  // same person the naming sheet would have created.
  return utterance.person_id ?? sessionSpeaker ?? utterance.voiceprint_id ?? `speaker-${utterance._id}`;
}

export function speakerIdentityFor(utterance: Utterance, ownerId: Id, sessionSpeaker?: Id): PersonRecord {
  return {
    _id: voiceKeyFor(utterance, sessionSpeaker),
    owner_id: ownerId,
    name: '',
    voiceprint_id: utterance.voiceprint_id,
    created_at: utterance.created_at,
    updated_at: utterance.updated_at,
  };
}

/**
 * VAD emits stray fragments — a lone "." or a single stray word — which are noise in a
 * transcript someone is reading.
 *
 * A duplicate is the same sentence at the same offsets arriving twice under different
 * ids. Matching on text alone deleted real repeated lines: two people saying "Yeah."
 * one after another is a conversation, not a glitch.
 */
export function visibleTurns(utterances: Utterance[]): Utterance[] {
  const visible: Utterance[] = [];
  for (const utterance of utterances) {
    if (utterance.text.replace(/[^a-zA-Z0-9]/g, '').length <= 1) continue;
    const previous = visible[visible.length - 1];
    if (previous
      && previous.text.trim() === utterance.text.trim()
      && previous.start_ms === utterance.start_ms
      && previous.end_ms === utterance.end_ms) continue;
    visible.push(utterance);
  }
  return visible;
}

/**
 * Consecutive turns by one voice, as a single readable block.
 *
 * This conversation has heavy overlapping speech: people interrupt, and a single
 * sentence is routinely cut into three or four rows by the VAD. Rendered one row per
 * turn, that reads as a stutter rather than as somebody talking. Grouping a run into one
 * block with one header is the biggest readability change available here, and it also
 * cuts what the list has to render — 2,772 turns collapse to roughly 900 blocks.
 *
 * Grouping is only ever by voice identity the server gave us: a person id, a diarization
 * cluster, or a voiceprint. A turn nobody has attributed falls back to a key unique to
 * itself and therefore never groups with anything. Merging turns from different speakers
 * to make the page tidier would be inventing attribution, which is the one thing this
 * product must not do.
 */
export interface TranscriptBlock {
  /** The first turn's id. Stable across rebuilds, so it works as a list key. */
  id: Id;
  voiceKey: Id;
  personId?: Id;
  utterances: Utterance[];
  startMs: number;
}

function sameBlock(a: TranscriptBlock, b: TranscriptBlock): boolean {
  if (a.id !== b.id || a.voiceKey !== b.voiceKey || a.personId !== b.personId) return false;
  if (a.utterances.length !== b.utterances.length) return false;
  for (let index = 0; index < a.utterances.length; index += 1) {
    if (a.utterances[index] !== b.utterances[index]) return false;
  }
  return true;
}

/**
 * `previous` lets unchanged blocks keep their object identity across rebuilds. A live
 * transcript appends to its last block, so without this every block in the list would be
 * a new object on every tick and no amount of memoization downstream would hold.
 */
export function buildTranscriptBlocks(
  visible: Utterance[],
  sessionSpeakerOf: Record<Id, Id> = {},
  previous: TranscriptBlock[] = [],
): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  let current: TranscriptBlock | null = null;

  for (const utterance of visible) {
    const voiceKey = voiceKeyFor(utterance, sessionSpeakerOf[utterance._id]);
    if (current && current.voiceKey === voiceKey) {
      current.utterances.push(utterance);
      continue;
    }
    current = {
      id: utterance._id,
      voiceKey,
      personId: utterance.person_id,
      utterances: [utterance],
      startMs: utterance.start_ms,
    };
    blocks.push(current);
  }

  for (let index = 0; index < blocks.length; index += 1) {
    const before = previous[index];
    if (before && sameBlock(before, blocks[index])) blocks[index] = before;
  }
  return blocks;
}

/**
 * Stable numbers for the voices nobody has named yet.
 *
 * With seven people in the room several voices are unnamed at once, and every one of
 * them rendering as "Unknown speaker" makes them impossible to tell apart or to talk
 * about — which matters most at exactly the moment you are trying to name one of them.
 * Numbered in order of first appearance so a voice keeps its number as the transcript
 * grows, and only counting voices that are actually unnamed so the numbers do not skip.
 */
export function unknownVoiceOrdinals(
  blocks: TranscriptBlock[],
  isNamed: (voiceKey: Id) => boolean,
): Map<Id, number> {
  const ordinals = new Map<Id, number>();
  for (const block of blocks) {
    if (ordinals.has(block.voiceKey) || isNamed(block.voiceKey)) continue;
    ordinals.set(block.voiceKey, ordinals.size + 1);
  }
  return ordinals;
}

/**
 * Every turn a voice spoke across the whole transcript.
 *
 * Naming used to claim only the run you tapped, which at three turns was the same thing
 * and at three thousand leaves the same voice unnamed in fifty other places. The voice
 * key is the server's own identity for that speaker, so claiming all of it is exactly as
 * well-founded as claiming one run.
 */
export function voiceTurnIds(blocks: TranscriptBlock[], voiceKey: Id): Id[] {
  const ids: Id[] = [];
  for (const block of blocks) {
    if (block.voiceKey !== voiceKey) continue;
    for (const utterance of block.utterances) ids.push(utterance._id);
  }
  return ids;
}
