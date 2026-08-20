import { describe, expect, it } from 'vitest';
import type { Utterance } from '../../../shared/contracts';
import {
  buildTranscriptBlocks,
  speakerIdentityFor,
  unknownVoiceOrdinals,
  visibleTurns,
  voiceTurnIds,
} from '../lib/transcript';

let clock = 0;
function turn(text: string, overrides: Partial<Utterance> = {}): Utterance {
  clock += 1;
  const start = overrides.start_ms ?? clock * 1000;
  return {
    _id: overrides._id ?? `u${clock}`,
    owner_id: 'owner',
    conversation_id: 'c-1',
    text,
    start_ms: start,
    end_ms: overrides.end_ms ?? start + 900,
    is_final: true,
    created_at: '2026-08-14T00:00:00.000Z',
    updated_at: '2026-08-14T00:00:00.000Z',
    ...overrides,
  };
}

describe('visible turns', () => {
  it('hides VAD fragments', () => {
    const visible = visibleTurns([turn('.'), turn('Hello there'), turn('—')]);
    expect(visible.map((utterance) => utterance.text)).toEqual(['Hello there']);
  });

  /**
   * Two people answering "Yeah." one after another is a conversation, not a glitch.
   * Matching duplicates on text alone deleted the second one.
   */
  it('keeps a genuinely repeated line', () => {
    const visible = visibleTurns([
      turn('Yeah.', { _id: 'a', person_id: 'p-1', start_ms: 0, end_ms: 500 }),
      turn('Yeah.', { _id: 'b', person_id: 'p-2', start_ms: 900, end_ms: 1400 }),
    ]);
    expect(visible).toHaveLength(2);
  });

  it('drops the same turn re-emitted at the same offsets under a new id', () => {
    const visible = visibleTurns([
      turn('It slipped again.', { _id: 'a', start_ms: 3400, end_ms: 6200 }),
      turn('It slipped again.', { _id: 'b', start_ms: 3400, end_ms: 6200 }),
    ]);
    expect(visible.map((utterance) => utterance._id)).toEqual(['a']);
  });
});

describe('speaker blocks', () => {
  it('groups a run of consecutive turns by one voice into a single block', () => {
    const blocks = buildTranscriptBlocks([
      turn('One', { _id: 'a', person_id: 'p-1' }),
      turn('Two', { _id: 'b', person_id: 'p-1' }),
      turn('Three', { _id: 'c', person_id: 'p-2' }),
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].utterances.map((u) => u._id)).toEqual(['a', 'b']);
    expect(blocks[1].utterances.map((u) => u._id)).toEqual(['c']);
  });

  /**
   * The one thing this must never do. Tidier output is not worth asserting that two
   * people are one person.
   */
  it('never merges turns from different speakers', () => {
    const blocks = buildTranscriptBlocks([
      turn('One', { _id: 'a', person_id: 'p-1' }),
      turn('Two', { _id: 'b', person_id: 'p-2' }),
      turn('Three', { _id: 'c', person_id: 'p-1' }),
    ]);
    expect(blocks.map((block) => block.personId)).toEqual(['p-1', 'p-2', 'p-1']);
  });

  it('never groups turns nobody has attributed', () => {
    const blocks = buildTranscriptBlocks([turn('One', { _id: 'a' }), turn('Two', { _id: 'b' })]);
    expect(blocks).toHaveLength(2);
  });

  /** The diarizer saying "same cluster" is attribution, so grouping on it is honest. */
  it('groups unattributed turns the diarizer put in one cluster', () => {
    const blocks = buildTranscriptBlocks(
      [turn('One', { _id: 'a' }), turn('Two', { _id: 'b' })],
      { a: 'cluster-0', b: 'cluster-0' },
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].voiceKey).toBe('cluster-0');
  });

  /** Without identity reuse, a live tick makes every block new and memoization dies. */
  it('keeps unchanged blocks referentially identical across rebuilds', () => {
    const turns = [
      turn('One', { _id: 'a', person_id: 'p-1' }),
      turn('Two', { _id: 'b', person_id: 'p-2' }),
    ];
    const first = buildTranscriptBlocks(turns);
    const appended = buildTranscriptBlocks(
      [...turns, turn('Three', { _id: 'c', person_id: 'p-3' })],
      {},
      first,
    );
    expect(appended[0]).toBe(first[0]);
    expect(appended[1]).toBe(first[1]);
    expect(appended[2]).not.toBe(first[1]);
  });

  it('rebuilds a block whose turn changed', () => {
    const first = buildTranscriptBlocks([turn('One', { _id: 'a', person_id: 'p-1' })]);
    const relabelled = buildTranscriptBlocks(
      [turn('One', { _id: 'a', person_id: 'p-9' })],
      {},
      first,
    );
    expect(relabelled[0]).not.toBe(first[0]);
    expect(relabelled[0].personId).toBe('p-9');
  });
});

describe('unnamed voices', () => {
  /** Seven people in a room, several unnamed: they have to be tellable apart. */
  it('numbers unnamed voices in order of first appearance', () => {
    const blocks = buildTranscriptBlocks([
      turn('One', { _id: 'a', person_id: 'p-1' }),
      turn('Two', { _id: 'b', person_id: 'p-2' }),
      turn('Three', { _id: 'c', person_id: 'p-1' }),
      turn('Four', { _id: 'd', person_id: 'p-3' }),
    ]);
    const ordinals = unknownVoiceOrdinals(blocks, (voice) => voice === 'p-2');
    expect(ordinals.get('p-1')).toBe(1);
    expect(ordinals.get('p-3')).toBe(2);
    // A named voice is not numbered, and does not consume a number either.
    expect(ordinals.has('p-2')).toBe(false);
  });
});

describe('claiming a voice', () => {
  /** Naming claimed one run before; across 48 minutes that leaves the voice unnamed. */
  it('collects every turn that voice spoke, not just the run tapped', () => {
    const blocks = buildTranscriptBlocks([
      turn('One', { _id: 'a', person_id: 'p-1' }),
      turn('Two', { _id: 'b', person_id: 'p-2' }),
      turn('Three', { _id: 'c', person_id: 'p-1' }),
      turn('Four', { _id: 'd', person_id: 'p-1' }),
    ]);
    expect(voiceTurnIds(blocks, 'p-1')).toEqual(['a', 'c', 'd']);
  });
});

describe('speaker identity', () => {
  /** Two code paths used to mint different ids for one voice, producing twins. */
  it('is the same id whichever way the speaker is named', () => {
    const unresolved = turn('Hi', { _id: 'u-9', voiceprint_id: 'vp-9' });
    expect(speakerIdentityFor(unresolved, 'owner')._id).toBe('vp-9');

    const noVoiceprint = turn('Hi', { _id: 'u-10' });
    expect(speakerIdentityFor(noVoiceprint, 'owner')._id).toBe('speaker-u-10');

    const resolved = turn('Hi', { _id: 'u-11', person_id: 'p-3', voiceprint_id: 'vp-3' });
    expect(speakerIdentityFor(resolved, 'owner')._id).toBe('p-3');
  });
});
