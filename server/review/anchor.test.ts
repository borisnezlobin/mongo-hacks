import { describe, expect, it } from 'vitest';
import { anchorCorrections, summariseAnchors, type AnchorLine } from './anchor';
import type { Correction } from './corrections';

const correction = (over: Partial<Correction>): Correction => ({
  id: 'c1', recording: 'dorm-40min', utterance_id: 'u5', at_ms: 19_360, end_ms: 24_140,
  original_text: "I'm Boris.", original_speaker_id: 'p1', original_speaker_name: 'Boris',
  asserts: ['speaker'], speaker: { person_id: 'p1', name: 'Boris' },
  created_at: '2026-08-18T10:00:00.000Z', ...over,
});
const line = (id: string, at: number, end: number, text: string): AnchorLine => ({ id, at_ms: at, end_ms: end, text });

describe('corrections surviving a re-seed', () => {
  it('leaves an unchanged line alone', () => {
    const anchored = anchorCorrections([correction({})], [line('u5', 19_360, 24_140, "I'm Boris.")]);
    expect(anchored[0]).toMatchObject({ state: 'exact', utterance_id: 'u5' });
  });

  it('follows the words when the id has moved to a different line', () => {
    // Seeding regenerates ids positionally, so u5 is whatever the sixth line is
    // today. The words and the time are the durable identity.
    const anchored = anchorCorrections(
      [correction({})],
      [line('u5', 800_000, 802_000, 'something else entirely'), line('u9', 19_360, 24_140, "I'm Boris.")],
    );
    expect(anchored[0]).toMatchObject({ state: 'rekeyed', utterance_id: 'u9' });
  });

  it('flags rather than guesses when the join re-cut the stretch', () => {
    const anchored = anchorCorrections(
      [correction({})],
      [line('u4', 19_000, 25_000, "I'm Boris. Nice to meet you. Where are you from?")],
    );
    expect(anchored[0].state).toBe('ambiguous');
    expect(anchored[0].detail).toMatch(/re-cut/);
  });

  it('orphans a correction whose stretch is gone rather than attaching it somewhere', () => {
    const anchored = anchorCorrections([correction({})], [line('u1', 900_000, 902_000, 'unrelated')]);
    expect(anchored[0]).toMatchObject({ state: 'orphaned', utterance_id: null });
  });

  it('refuses to merge two disagreeing corrections onto one line', () => {
    // This is the failure it exists for: two corrections were re-keyed onto the
    // same merged line and got away with it only because both said Volva.
    const anchored = anchorCorrections(
      [
        correction({ id: 'a', utterance_id: 'old1', at_ms: 19_360, end_ms: 20_400, original_text: 'one', speaker: { person_id: 'p1', name: 'Boris' } }),
        correction({ id: 'b', utterance_id: 'old2', at_ms: 20_500, end_ms: 21_400, original_text: 'two', speaker: { person_id: 'p6', name: 'Volva' } }),
      ],
      [line('merged', 19_300, 21_500, 'one two merged together')],
    );
    expect(anchored.every((entry) => entry.state === 'ambiguous')).toBe(true);
    expect(anchored[0].detail).toMatch(/do not agree/);
  });

  it('stays quiet when two re-keyed corrections agree', () => {
    const anchored = anchorCorrections(
      [
        correction({ id: 'a', utterance_id: 'old1', at_ms: 19_360, end_ms: 20_400, original_text: 'one', speaker: { person_id: 'p6', name: 'Volva' } }),
        correction({ id: 'b', utterance_id: 'old2', at_ms: 20_500, end_ms: 21_400, original_text: 'two', speaker: { person_id: 'p6', name: 'Volva' } }),
      ],
      [line('merged', 19_300, 21_500, 'one two merged together')],
    );
    expect(anchored.every((entry) => entry.detail.includes('do not agree'))).toBe(false);
  });

  it('summarises what happened', () => {
    const report = summariseAnchors(anchorCorrections([correction({})], [line('u5', 19_360, 24_140, "I'm Boris.")]));
    expect(report).toMatchObject({ exact: 1, rekeyed: 0, ambiguous: 0, orphaned: 0 });
  });
});
