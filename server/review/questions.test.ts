import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { groundTruthPath, openQuestions } from './questions';

const present = existsSync(groundTruthPath('dorm-40min'));

describe('same-or-different questions', () => {
  it.runIf(present)('builds every open question with audio on both sides', () => {
    const questions = openQuestions('dorm-40min');
    expect(questions.length).toBeGreaterThan(0);
    for (const question of questions) {
      expect(question.clips_a.length).toBeGreaterThan(0);
      expect(question.clips_b.length).toBeGreaterThan(0);
      expect(question.worth_seconds).toBeGreaterThan(0);
    }
  });

  it.runIf(present)('puts every clip on the label it actually belongs to', () => {
    // The builder writes clips for the FIRST label only, and `at` is the clip
    // start. Resolving by containment instead returns 0:A and 0:G for a
    // question about 0:E, which would have him compare the wrong voices.
    for (const question of openQuestions('dorm-40min')) {
      for (const clip of question.clips_a) expect(clip.label).toBe(question.label_a);
      for (const clip of question.clips_b) expect(clip.label).toBe(question.label_b);
    }
  });

  it.runIf(present)('never offers a clip of a side against itself', () => {
    for (const question of openQuestions('dorm-40min')) {
      expect(question.label_a).not.toBe(question.label_b);
      const a = new Set(question.clips_a.map((clip) => `${clip.start_ms}:${clip.end_ms}`));
      for (const clip of question.clips_b) expect(a.has(`${clip.start_ms}:${clip.end_ms}`)).toBe(false);
    }
  });

  it.runIf(present)('offers clips long enough to recognise a voice from', () => {
    for (const question of openQuestions('dorm-40min')) {
      const longest = (clips: { start_ms: number; end_ms: number }[]) =>
        Math.max(...clips.map((clip) => clip.end_ms - clip.start_ms));
      expect(longest(question.clips_a)).toBeGreaterThan(2_000);
      expect(longest(question.clips_b)).toBeGreaterThan(2_000);
    }
  });

  it.runIf(present)('orders by what an answer is worth', () => {
    const worth = openQuestions('dorm-40min').map((question) => question.worth_seconds);
    expect([...worth].sort((a, b) => b - a)).toEqual(worth);
  });

  it('returns nothing for a recording with no builder output', () => {
    expect(openQuestions('no-such-recording')).toEqual([]);
  });
});

describe('the clips are the anchor, not the labels', () => {
  it.runIf(present)('offers the longest clip first on each side, which is what gets recorded', () => {
    // "Play A then B" plays clips_a[0] and clips_b[0], and those two spans are
    // what the answer is stored against. They have to be the best evidence
    // available, not whatever the file happened to list first.
    for (const question of openQuestions('dorm-40min')) {
      const lengths = (clips: { start_ms: number; end_ms: number }[]) =>
        clips.map((clip) => clip.end_ms - clip.start_ms);
      for (const side of [question.clips_a, question.clips_b]) {
        expect(lengths(side)[0]).toBe(Math.max(...lengths(side)));
      }
    }
  });

  it.runIf(present)('gives every clip an absolute position in the recording', () => {
    // Timestamps are absolute audio positions, so they survive the join
    // changing underneath them; cluster ids do not.
    for (const question of openQuestions('dorm-40min')) {
      for (const clip of [...question.clips_a, ...question.clips_b]) {
        expect(clip.start_ms).toBeGreaterThan(0);
        expect(clip.end_ms).toBeGreaterThan(clip.start_ms);
        expect(clip.end_ms).toBeLessThan(2_902_000);
      }
    }
  });
});
