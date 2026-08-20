import { describe, expect, it } from 'vitest';
import type { Utterance } from '../../shared/contracts';
import { hasRealRecording, missingRecordingNotice, readRealLines } from '../../fixtures/real-audio';
import {
  ConversationWindow,
  WINDOW_CHAR_BUDGET,
  WINDOW_MAX_WAIT_MS,
  coalesceTurns,
  contentWordCount,
  splitIntoWindows,
  windowChars,
} from './window';

let sequence = 0;

function utterance(text: string, options: Partial<Utterance> = {}): Utterance {
  sequence += 1;
  return {
    _id: options._id ?? `u-${sequence}`,
    owner_id: 'owner',
    conversation_id: 'c-1',
    text,
    start_ms: sequence * 1_000,
    end_ms: sequence * 1_000 + 500,
    is_final: true,
    created_at: '2026-08-17T00:00:00Z',
    updated_at: '2026-08-17T00:00:00Z',
    ...options,
  };
}

describe('content words', () => {
  it('counts nothing in a backchannel turn', () => {
    expect(contentWordCount('Yeah.')).toBe(0);
    expect(contentWordCount('Oh okay')).toBe(0);
    expect(contentWordCount('Wait, what?')).toBe(0);
  });

  it('still counts the single content word in a short but real claim', () => {
    expect(contentWordCount("I'm a sophomore")).toBe(1);
  });

  it('counts the substance of a full sentence', () => {
    expect(contentWordCount('I study applied maths and my sister is at university')).toBeGreaterThan(3);
  });
});

describe('turn coalescing', () => {
  it('joins a sentence the transcriber split into fragments', () => {
    const turns = coalesceTurns([
      utterance('I', { person_id: 'p-a', start_ms: 0, end_ms: 300 }),
      utterance('study applied maths', { person_id: 'p-a', start_ms: 400, end_ms: 1_200 }),
      utterance('Oh nice.', { person_id: 'p-b', start_ms: 1_300, end_ms: 1_800 }),
    ]);

    expect(turns).toHaveLength(2);
    expect(turns[0]?.text).toBe('I study applied maths');
    expect(turns[0]?.member_utterance_ids).toHaveLength(2);
  });

  it('keeps a long pause by the same speaker as two turns', () => {
    const turns = coalesceTurns([
      utterance('So anyway', { person_id: 'p-a', start_ms: 0, end_ms: 500 }),
      utterance('where were we', { person_id: 'p-a', start_ms: 20_000, end_ms: 21_000 }),
    ]);

    expect(turns).toHaveLength(2);
  });

  it('cites the utterance the turn started on', () => {
    const turns = coalesceTurns([
      utterance('My sister', { _id: 'u-first', person_id: 'p-a', start_ms: 0, end_ms: 300 }),
      utterance('goes to Cal Poly', { _id: 'u-second', person_id: 'p-a', start_ms: 400, end_ms: 1_000 }),
    ]);

    expect(turns[0]?.utterance_id).toBe('u-first');
  });
});

describe('live conversation window', () => {
  it('is not ready while the window holds only backchannel', () => {
    const window = new ConversationWindow();
    for (const text of ['Yeah.', 'Oh.', 'Right.', 'Mhm.']) window.add(utterance(text), 0);

    expect(window.isReady(WINDOW_MAX_WAIT_MS * 4)).toBe(false);
  });

  it('fires on the wait timer once something substantive was said', () => {
    const window = new ConversationWindow();
    window.add(utterance('I moved here from Seattle last August and I study industrial engineering'), 0);
    window.add(utterance('My sister is at the state school down the coast doing marine biology'), 0);

    expect(window.isReady(0)).toBe(false);
    expect(window.isReady(WINDOW_MAX_WAIT_MS)).toBe(true);
  });

  it('fires on the character budget before the timer when people are talking', () => {
    const window = new ConversationWindow();
    const line = 'I grew up outside the city and my whole family still lives there in the same house. ';
    let added = 0;
    while (added < WINDOW_CHAR_BUDGET) {
      window.add(utterance(line), 0);
      added += line.length;
    }

    expect(window.isReady(0)).toBe(true);
  });

  it('carries the tail forward so a claim split across the boundary is seen whole', () => {
    const window = new ConversationWindow();
    const filler = 'We were talking about the dorm laundry situation for a very long time indeed. ';
    while (windowChars(window.peek()) < WINDOW_CHAR_BUDGET) window.add(utterance(filler), 0);
    window.add(utterance('My sister goes to Cal Poly', { _id: 'u-tail' }), 0);

    const taken = window.take();
    expect(taken.some((item) => item._id === 'u-tail')).toBe(true);
    expect(window.peek().some((item) => item._id === 'u-tail')).toBe(true);
  });

  it('starts the wait clock on new speech, not on the carried-over tail', () => {
    const window = new ConversationWindow();
    const filler = 'We were talking about the dorm laundry situation for a very long time indeed. ';
    while (windowChars(window.peek()) < WINDOW_CHAR_BUDGET) window.add(utterance(filler), 0);
    window.take();

    expect(window.waitRemainingMs(0)).toBeUndefined();
    expect(window.isReady(WINDOW_MAX_WAIT_MS * 10)).toBe(false);
  });
});

describe('offline splitting', () => {
  it('covers every utterance', () => {
    const utterances = Array.from({ length: 200 }, (_, index) =>
      utterance(`Line number ${index} with a reasonable amount of actual content in it.`));
    const windows = splitIntoWindows(utterances, 1_000, 200);

    const covered = new Set(windows.flat().map((item) => item._id));
    expect(covered.size).toBe(utterances.length);
  });

  it('leaves a short conversation as one window', () => {
    const windows = splitIntoWindows([utterance('Hello there'), utterance('Hi')], 1_000, 200);
    expect(windows).toHaveLength(1);
  });
});

const RECORDING = 'dorm-40min';

describe('cost of the real 48-minute recording', () => {
  it.skipIf(!hasRealRecording(RECORDING))('needs an order of magnitude fewer calls than one per turn', () => {
    const utterances: Utterance[] = readRealLines(RECORDING).map((line, index) => utterance(line.text, {
      _id: `real-${index}`,
      person_id: `p-${line.speaker}`,
      start_ms: line.start_ms,
      end_ms: line.end_ms,
    }));

    const window = new ConversationWindow();
    let calls = 0;
    for (const item of utterances) {
      window.add(item, item.start_ms);
      if (!window.isReady(item.end_ms)) continue;
      window.take();
      calls += 1;
    }
    if (window.isReady(utterances[utterances.length - 1]!.end_ms)) calls += 1;

    const elapsedMinutes = utterances[utterances.length - 1]!.end_ms / 60_000;
    // One call per elapsed minute is the ceiling the wait timer imposes, and it
    // is what actually binds: this conversation never fills a window faster.
    expect(calls).toBeLessThanOrEqual(Math.ceil(elapsedMinutes) + 1);
    // Per-turn is the thing being beaten, and the real join produces 767 lines
    // where the retired provider produced 2,772 fragments — so the same wall
    // clock buys a smaller multiple against a smaller denominator. The wait
    // timer above is the binding claim; this one only says batching happened.
    expect(calls).toBeLessThan(utterances.length / 10);
  });

  it.skipIf(hasRealRecording(RECORDING))('is skipped without the recording', () => {
    expect(missingRecordingNotice(RECORDING)).toContain('deliberately not committed');
  });
});
