import { describe, expect, it } from 'vitest';
import { hasRealFixture, readRealFixture } from '../fixtures/real-audio';
import { LANDMARKS, checkLandmarks } from './landmarks';
import type { AttributedSegment } from './scoring';

// The transcript the product actually produces. This used to read
// dorm-40min.merged.json, the retired realtime provider's output, which renders
// spelled-out letters as "M_A_R_T_" and garbles the speech around them — so a
// landmark quoting the current transcript failed a check that was only ever
// meant to catch typos.
const dormFixture = 'dorm-40min.whisper.json';

describe('landmarks', () => {
  it('catches a merge that the speaker count hides', () => {
    // Boris and Vova introduce themselves to each other, and a system files
    // both under one voice while still reporting the right number of people.
    // This is the real bug that was live in server/audio, reduced to two spans.
    const merged: AttributedSegment[] = [
      { speaker: 'one', start_ms: 18_000, end_ms: 30_000 },
      { speaker: 'two', start_ms: 2_466_000, end_ms: 2_467_000 },
    ];
    const report = checkLandmarks('dorm-40min', merged);
    expect(report.merges.length).toBeGreaterThan(0);
    expect(report.merges[0].systemA).toBe('one');
  });

  it('catches one person split across two voices', () => {
    const split: AttributedSegment[] = [
      { speaker: 'early', start_ms: 0, end_ms: 100_000 },
      { speaker: 'late', start_ms: 1_600_000, end_ms: 1_700_000 },
    ];
    const report = checkLandmarks('dorm-40min', split);
    // Boris introduces himself at 18 s and reads out the borisen.com email at
    // 1633 s. Two voices for those two lines is a split, whatever the seconds say.
    expect(report.splits.some((pair) => pair.a.person === 'boris' && pair.b.person === 'boris')).toBe(true);
  });

  it('passes a system that gets every landmark right', () => {
    const correct: AttributedSegment[] = LANDMARKS.filter(
      (landmark) => landmark.recording === 'dorm-40min',
    ).map((landmark) => ({
      speaker: landmark.person ?? 'somebody-else',
      start_ms: landmark.at_ms,
      end_ms: landmark.end_ms,
    }));
    const report = checkLandmarks('dorm-40min', correct);
    expect(report.merges).toHaveLength(0);
    expect(report.splits).toHaveLength(0);
    expect(report.covered).toBe(report.total);
  });

  it('reports constraints as unresolved rather than passing when nothing is said', () => {
    const report = checkLandmarks('dorm-40min', []);
    expect(report.covered).toBe(0);
    expect(report.merges).toHaveLength(0);
    expect(report.pairs.every((pair) => pair.verdict === 'unresolved')).toBe(true);
  });

  it.skipIf(!hasRealFixture(dormFixture))('quotes lines that exist in the transcript', () => {
    const segments = readRealFixture<{ segments: { start: number; text: string }[] }>(dormFixture).segments;
    for (const landmark of LANDMARKS.filter((entry) => entry.recording === 'dorm-40min')) {
      const found = segments.some(
        (segment) =>
          Math.abs(segment.start * 1000 - landmark.at_ms) < 700 &&
          segment.text.includes(landmark.quote.replace(/\.$/, '')),
      );
      expect(found, `${landmark.at_ms}ms "${landmark.quote}"`).toBe(true);
    }
  });
});
