import { describe, expect, it } from 'vitest';
import { hasRealFixture, missingFixtureNotice } from '../../fixtures/real-audio';
import { gapsBetween, wordsForLine } from './words';

const FIXTURE = 'dorm-40min.whisper.json';
const present = hasRealFixture(FIXTURE);

describe('cuts land between words, using real timings', () => {
  it.runIf(present)('reads the words of the line the owner asked to split', () => {
    // dorm-40min u1: three sentences, at least two speakers. The pipeline
    // delivers it as one turn, which is why he could not express the fix.
    const words = wordsForLine('dorm-40min', 19_360, 24_140)!;
    expect(words.map((word) => word.text).join(' ')).toBe(
      "I'm Boris. Nice to meet you. Where are you from? I'm from Poland, but my parents are from Russia.",
    );
    expect(words[0]).toMatchObject({ text: "I'm", start_ms: 19_360 });
  });

  it.runIf(present)('offers a cut in every gap, and marks the sentence ends', () => {
    const words = wordsForLine('dorm-40min', 19_360, 24_140)!;
    const gaps = gapsBetween(words);
    expect(gaps).toHaveLength(words.length - 1);

    // "Where are you from?" begins here — the cut the owner actually wants.
    const beforeWhere = gaps.find((gap) => words[gap.index].text === 'Where')!;
    expect(beforeWhere).toMatchObject({ from_ms: 20_800, to_ms: 20_840, sentence_end: true });
  });

  it.runIf(present)('keeps the silence around a cut rather than collapsing it to an instant', () => {
    const words = wordsForLine('dorm-40min', 19_360, 24_140)!;
    const gaps = gapsBetween(words);
    const wide = gaps.find((gap) => gap.to_ms - gap.from_ms > 400)!;
    // 21.52-21.96: nothing in the audio says where inside this the speaker
    // changed, so the reference must not pretend to know.
    expect(wide.to_ms - wide.from_ms).toBe(440);
  });

  it('returns null when there is no timed transcript, rather than inventing timings', () => {
    expect(wordsForLine('no-such-conversation', 0, 1_000)).toBeNull();
  });

  it('marks a sentence end through a closing quote', () => {
    const gaps = gapsBetween([
      { text: 'done."', start_ms: 0, end_ms: 100 },
      { text: 'Next', start_ms: 300, end_ms: 400 },
    ]);
    expect(gaps[0].sentence_end).toBe(true);
  });

  it('does not treat an abbreviation mid-word as a boundary it cannot cut', () => {
    const gaps = gapsBetween([
      { text: 'the', start_ms: 0, end_ms: 100 },
      { text: 'cat', start_ms: 100, end_ms: 200 },
    ]);
    expect(gaps[0]).toMatchObject({ index: 1, from_ms: 100, to_ms: 100, sentence_end: false });
  });
});

if (!present) {
  describe('word timings', () => {
    it.skip(`skipped: ${missingFixtureNotice(FIXTURE)}`, () => {});
  });
}
