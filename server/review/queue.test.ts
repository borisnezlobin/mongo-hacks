import { describe, expect, it } from 'vitest';
import { rankLines, speakerCoverage, speechShare, TARGET_PER_SPEAKER } from './queue';

const line = (id: string, at: number, ms: number, person: string | null) => ({
  id, at_ms: at, end_ms: at + ms, person_id: person,
});

/** Two long voices and one short one, spread across the recording. */
const lines = [
  line('a1', 0, 4_000, 'big'), line('a2', 100_000, 4_000, 'big'), line('a3', 200_000, 4_000, 'big'),
  line('b1', 10_000, 3_000, 'small'), line('b2', 210_000, 3_000, 'small'),
  line('c1', 20_000, 400, 'tiny'),
];

describe('what to review next', () => {
  it('leads with the voice that holds the most speech and has no ground truth', () => {
    // Three of eight labels carry no landmark and hold 65% of all speech. A
    // deficit that ignores size treats the biggest dark voice like the smallest.
    const ranked = rankLines('none', lines, new Set(), new Map());
    const first = lines.find((candidate) => candidate.id === ranked[0].id)!;
    expect(first.person_id).toBe('big');
    expect(ranked[0].reason).toMatch(/never had a confirmed line/);
  });

  it('offers a long turn first for a voice nobody has identified', () => {
    // A 400ms "yeah." cannot identify a stranger, and it was being offered as
    // the first anchor for the largest unlabelled speaker.
    const ranked = rankLines('none', lines, new Set(), new Map());
    const tinyAt = ranked.findIndex((entry) => entry.id === 'c1');
    const longAt = ranked.findIndex((entry) => entry.id === 'a1');
    expect(longAt).toBeLessThan(tinyAt);
  });

  it('moves on once a voice has been pinned, instead of asking about it again', () => {
    const ranked = rankLines('none', lines, new Set(), new Map());
    const speakers = ranked.slice(0, 3).map((entry) => lines.find((l) => l.id === entry.id)!.person_id);
    expect(new Set(speakers).size).toBeGreaterThan(1);
  });

  it('drops lines already reviewed out of the queue entirely', () => {
    const ranked = rankLines('none', lines, new Set(['a1', 'a2']), new Map());
    expect(ranked.map((entry) => entry.id)).not.toContain('a1');
    expect(ranked).toHaveLength(lines.length - 2);
  });

  it('deprioritises a voice that already has confirmations', () => {
    const ranked = rankLines('none', lines, new Set(), new Map([['big', 5]]));
    expect(lines.find((candidate) => candidate.id === ranked[0].id)!.person_id).not.toBe('big');
  });

  it('is deterministic', () => {
    const once = rankLines('none', lines, new Set(), new Map()).map((entry) => entry.id);
    const twice = rankLines('none', lines, new Set(), new Map()).map((entry) => entry.id);
    expect(once).toEqual(twice);
  });

  it('measures each voice share of the room', () => {
    const share = speechShare(lines);
    expect(share.get('big')).toBeCloseTo(12_000 / 18_400, 3);
    expect(share.get('tiny')).toBeCloseTo(400 / 18_400, 3);
  });

  it('reports coverage darkest and largest first', () => {
    const coverage = speakerCoverage(lines, new Map([['big', TARGET_PER_SPEAKER]]));
    expect(coverage[0].person_id).toBe('small');
    expect(coverage.find((row) => row.person_id === 'big')!.wanted).toBe(0);
  });
});
