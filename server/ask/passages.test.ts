import { describe, expect, it } from 'vitest';
import { hasRealRecording, missingRecordingNotice, readRealLines } from '../../fixtures/real-audio';
import {
  buildPassages,
  distinctiveTerms,
  indexPassages,
  informationScore,
  PASSAGE_TARGET_WORDS,
  representativeUtterances,
  selectRepresentative,
  type PassageUtterance,
} from './passages';

function turn(id: string, speaker: string, text: string, startSeconds: number, seconds = 2): PassageUtterance {
  return {
    id,
    person_id: speaker,
    text,
    start_ms: startSeconds * 1_000,
    end_ms: (startSeconds + seconds) * 1_000,
  };
}

const words = (count: number, seed: string) =>
  Array.from({ length: count }, (_, index) => `${seed}${index}`).join(' ');

describe('grouping turns into passages', () => {
  it('keeps a short exchange whole rather than cutting on a word count', () => {
    const passages = buildPassages('c1', [
      turn('u1', 'p1', 'where are you living next year', 0),
      turn('u2', 'p2', 'a house on Dwight with four other people', 3),
    ]);
    expect(passages).toHaveLength(1);
    expect(passages[0].utterances.map((utterance) => utterance.id)).toEqual(['u1', 'u2']);
  });

  it('cuts at a speaker change once the passage has reached its target size', () => {
    const passages = buildPassages('c1', [
      turn('u1', 'p1', words(PASSAGE_TARGET_WORDS, 'a'), 0, 40),
      turn('u2', 'p2', words(20, 'b'), 41),
    ]);
    expect(passages).toHaveLength(2);
    expect(passages[1].utterances[0].id).toBe('u2');
  });

  it('cuts at a long silence even when the same person keeps talking', () => {
    const passages = buildPassages('c1', [
      turn('u1', 'p1', words(PASSAGE_TARGET_WORDS, 'a'), 0, 40),
      turn('u2', 'p1', words(20, 'b'), 60),
    ]);
    expect(passages).toHaveLength(2);
  });

  it('caps a monologue that never yields and never pauses', () => {
    const passages = buildPassages('c1', [turn('u1', 'p1', words(900, 'a'), 0, 300)]);
    expect(passages).toHaveLength(1);
    const [passage] = buildPassages('c1', [
      turn('u1', 'p1', words(400, 'a'), 0, 100),
      turn('u2', 'p1', words(400, 'b'), 100, 100),
    ]);
    expect(passage.utterances).toHaveLength(1);
  });

  it('loses no turn and keeps them in order', () => {
    const turns = Array.from({ length: 200 }, (_, index) =>
      turn(`u${index}`, `p${index % 3}`, words(8, `w${index}`), index * 5),
    );
    const passages = buildPassages('c1', turns);
    const flattened = passages.flatMap((passage) => passage.utterances.map((utterance) => utterance.id));
    expect(flattened).toEqual(turns.map((item) => item.id));
  });

  it('records every speaker who appears in the passage', () => {
    const [passage] = buildPassages('c1', [
      turn('u1', 'p1', 'hey', 0),
      turn('u2', 'p2', 'hey', 2),
      turn('u3', 'p1', 'how was the flight', 4),
    ]);
    expect(passage.speaker_ids).toEqual(['p1', 'p2']);
  });
});

describe('what a passage is about', () => {
  const block = (prefix: string, speaker: string, line: string, from: number) =>
    Array.from({ length: 10 }, (_, index) => turn(`${prefix}${index}`, speaker, line, from + index * 3));

  const conversation = [
    ...block('m', 'p1', 'applied maths with a double major in industrial engineering operations research coursework', 0),
    ...block('f', 'p2', 'the flight was delayed in Denver and the airline lost my bag overnight', 40),
    ...block('y', 'p3', 'yeah yeah for sure yeah', 80),
  ];
  const index = indexPassages(buildPassages('c1', conversation));
  const passageAbout = (word: string) => index.passages.find((passage) => passage.text.includes(word))!;

  it('splits into one passage per subject', () => {
    expect(index.passages).toHaveLength(3);
  });

  it('scores a stretch of backchannel below a stretch that says something', () => {
    expect(informationScore(passageAbout('maths'), index)).toBeGreaterThan(
      informationScore(passageAbout('yeah'), index),
    );
    expect(informationScore(passageAbout('flight'), index)).toBeGreaterThan(
      informationScore(passageAbout('yeah'), index),
    );
  });

  it('labels a passage with words that set it apart from the rest', () => {
    const topics = distinctiveTerms(passageAbout('maths'), index);
    const elsewhere = `${passageAbout('flight').text} ${passageAbout('yeah').text}`;

    expect(topics.length).toBeGreaterThan(2);
    expect(topics.every((term) => passageAbout('maths').text.includes(term))).toBe(true);
    expect(topics.some((term) => elsewhere.includes(term))).toBe(false);
  });

  it('quotes the line that carries content, not the backchannel next to it', () => {
    const mixed = buildPassages('c2', [
      turn('u-yeah-1', 'p1', 'yeah yeah for sure', 0),
      turn('u-maths', 'p1', 'I am doing applied maths with operations research', 3, 6),
      turn('u-yeah-2', 'p1', 'yeah for sure right', 10),
    ]);
    const mixedIndex = indexPassages([...mixed, ...index.passages]);
    const quotes = representativeUtterances(mixed[0], mixedIndex, 8);
    expect(quotes.map((quote) => quote.id)).toEqual(['u-maths']);
  });

  it('returns quotes in the order they were said', () => {
    const [passage] = buildPassages('c1', [
      turn('u1', 'p1', 'so what are you studying', 0),
      turn('u2', 'p2', 'industrial engineering and operations research', 3),
    ]);
    const index = indexPassages([passage]);
    expect(representativeUtterances(passage, index, 100).map((quote) => quote.id)).toEqual(['u1', 'u2']);
  });
});

describe('representative selection', () => {
  const longConversation = Array.from({ length: 300 }, (_, index) =>
    turn(`u${index}`, `p${index % 4}`, words(30, `t${index}`), index * 20),
  );

  it('spreads its picks across the whole conversation instead of one cluster', () => {
    const index = indexPassages(buildPassages('c1', longConversation));
    const chosen = selectRepresentative(index, { slots: 10 });

    expect(chosen).toHaveLength(10);
    expect(chosen[0].index).toBeLessThan(index.passages.length * 0.15);
    expect(chosen[chosen.length - 1].index).toBeGreaterThan(index.passages.length * 0.85);
  });

  it('lets relevance choose within a span but never empty one', () => {
    const index = indexPassages(buildPassages('c1', longConversation));
    const last = index.passages[index.passages.length - 1];
    const chosen = selectRepresentative(index, { slots: 5, focus: new Map([[last.id, 1]]) });

    expect(chosen).toHaveLength(5);
    expect(chosen.map((passage) => passage.id)).toContain(last.id);
    expect(chosen[0].index).toBeLessThan(index.passages.length * 0.25);
  });

  it('returns everything when the budget is larger than the conversation', () => {
    const index = indexPassages(buildPassages('c1', longConversation.slice(0, 4)));
    expect(selectRepresentative(index, { slots: 50 })).toHaveLength(index.passages.length);
  });
});

const RECORDING = 'dorm-40min';

describe('a real 48-minute conversation', () => {
  const available = hasRealRecording(RECORDING);
  const maybe = available ? it : it.skip;
  if (!available) it.skip(missingRecordingNotice(RECORDING), () => undefined);

  const load = (): PassageUtterance[] =>
    readRealLines(RECORDING).map((line) => ({
      id: line.id,
      person_id: line.speaker,
      text: line.text,
      start_ms: line.start_ms,
      end_ms: line.end_ms,
    }));

  maybe('reduces a whole recording to a few dozen passages', () => {
    const turns = load();
    // The retired provider cut this recording into 2,772 fragments; the join
    // the product actually runs produces 767 longer lines, because a line ends
    // where the speaker changes rather than where a VAD paused. The reduction
    // ratio is the claim worth asserting — the raw count is a property of the
    // segmenter, not of this module.
    expect(turns.length).toBeGreaterThan(500);

    const passages = buildPassages('dorm', turns);
    expect(passages.length).toBeGreaterThan(10);
    expect(passages.length).toBeLessThan(turns.length / 10);
    expect(passages.flatMap((passage) => passage.utterances).length).toBe(turns.length);
  });

  maybe('samples the whole recording, not the start of it', () => {
    const index = indexPassages(buildPassages('dorm', load()));
    const chosen = selectRepresentative(index, { slots: 16 });
    const lastMs = index.passages[index.passages.length - 1].end_ms;

    expect(chosen[0].start_ms).toBeLessThan(lastMs * 0.1);
    expect(chosen[chosen.length - 1].start_ms).toBeGreaterThan(lastMs * 0.85);
  });

  maybe('keeps speaker attribution on every quoted line', () => {
    const index = indexPassages(buildPassages('dorm', load()));
    const quotes = selectRepresentative(index, { slots: 16 }).flatMap((passage) =>
      representativeUtterances(passage, index, 30),
    );

    expect(quotes.length).toBeGreaterThan(16);
    expect(quotes.every((quote) => Boolean(quote.person_id))).toBe(true);
    expect(new Set(quotes.map((quote) => quote.person_id)).size).toBeGreaterThan(1);
  });

  maybe('prefers lines that say something over lines that agree', () => {
    const index = indexPassages(buildPassages('dorm', load()));
    const passages = selectRepresentative(index, { slots: 16 });
    const quoted = passages.flatMap((passage) => representativeUtterances(passage, index, 30));
    const everyLine = passages.flatMap((passage) => passage.utterances);

    const meanWords = (turns: PassageUtterance[]) =>
      turns.reduce((total, item) => total + item.text.trim().split(/\s+/).length, 0) / turns.length;

    expect(meanWords(quoted)).toBeGreaterThan(meanWords(everyLine));
  });
});
