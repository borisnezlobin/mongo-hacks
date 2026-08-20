import { describe, expect, it } from 'vitest';
import { assign, collarSensitivity, score, type AttributedSegment, type Reference } from './scoring';

const second = 1_000;

function reference(spans: [string, number, number][], excluded: [number, number][] = []): Reference {
  return {
    spans: spans.map(([speaker, start, end]) => ({
      speaker,
      start_ms: start * second,
      end_ms: end * second,
    })),
    excluded: excluded.map(([start, end]) => ({
      speaker: 'excluded',
      start_ms: start * second,
      end_ms: end * second,
    })),
    durationMs: 100 * second,
    truePeople: new Set(spans.map(([speaker]) => speaker)).size,
  };
}

function system(spans: [string, number, number][]): AttributedSegment[] {
  return spans.map(([speaker, start, end]) => ({
    speaker,
    start_ms: start * second,
    end_ms: end * second,
  }));
}

/** Long spans and no collar, so every assertion is about who, not about edges. */
const noCollar = { collarMs: 0 };

describe('assign', () => {
  it('maximises total weight rather than taking the best row first', () => {
    // Greedy would give row 0 its 10 and leave row 1 with 1, totalling 11.
    // The optimal pairing is 9 + 8 = 17.
    const result = assign([
      [10, 9],
      [8, 1],
    ]);
    expect(result).toEqual([1, 0]);
  });

  it('leaves a person unmapped when no cluster covers them at all', () => {
    expect(assign([[5, 0], [0, 0]])).toEqual([0, -1]);
  });

  it('handles more clusters than people', () => {
    const result = assign([[1, 9, 2]]);
    expect(result).toEqual([1]);
  });
});

describe('score', () => {
  it('calls a perfect relabelling perfect, whatever the cluster ids are', () => {
    const result = score(
      reference([
        ['boris', 0, 10],
        ['vova', 10, 20],
      ]),
      system([
        ['cluster-7', 0, 10],
        ['cluster-2', 10, 20],
      ]),
      noCollar,
    );
    expect(result.unexplainedRate).toBe(0);
    expect(result.der).toBe(0);
    expect(result.mapping.get('boris')).toBe('cluster-7');
  });

  it('does not reward a system for abstaining', () => {
    const truth = reference([
      ['boris', 0, 10],
      ['vova', 10, 20],
    ]);
    // Speaks up about half the recording and gets that half exactly right.
    const partial = score(truth, system([['a', 0, 10]]), noCollar);
    // Speaks up about all of it and gets the same half right.
    const full = score(truth, system([['a', 0, 10], ['b', 10, 15], ['a', 15, 20]]), noCollar);

    expect(partial.confusionMs).toBe(0);
    // The abstaining system has zero confusion, which is exactly the trap. The
    // headline number has to see through it, and both systems have half the
    // reference unaccounted for.
    expect(partial.unexplainedRate).toBeCloseTo(0.5, 6);
    expect(full.unexplainedRate).toBeCloseTo(0.25, 6);
    expect(full.unexplainedRate).toBeLessThan(partial.unexplainedRate);
  });

  it('counts a merged pair of people as error rather than as two half-credits', () => {
    const result = score(
      reference([
        ['boris', 0, 10],
        ['vova', 10, 20],
      ]),
      system([['everyone', 0, 20]]),
      noCollar,
    );
    // One cluster can only be one person, so the other person's whole turn is
    // confusion. Collapsing a room onto one voice must never score 0%.
    expect(result.unexplainedRate).toBeCloseTo(0.5, 6);
    expect(result.systemSpeakers).toBe(1);
    expect(result.truePeople).toBe(2);
  });

  it('makes over-splitting visible as unmapped speakers', () => {
    const result = score(
      reference([['boris', 0, 20]]),
      system([
        ['a', 0, 10],
        ['b', 10, 20],
      ]),
      noCollar,
    );
    expect(result.spuriousSpeakers).toEqual(['b']);
    expect(result.unexplainedRate).toBeCloseTo(0.5, 6);
  });

  it('charges invented speech to false alarm, not to the headline', () => {
    const result = score(
      reference([['boris', 0, 10]]),
      system([
        ['a', 0, 10],
        ['a', 20, 30],
      ]),
      noCollar,
    );
    expect(result.unexplainedRate).toBe(0);
    expect(result.falseAlarmMs).toBe(10 * second);
    expect(result.der).toBeCloseTo(1, 6);
  });

  it('removes excluded time from the reference, the system and the denominator', () => {
    const truth = reference([['boris', 0, 10], ['vova', 10, 20]], [[10, 20]]);
    // Whatever it says about the excluded stretch cannot help or hurt it.
    const quiet = score(truth, system([['a', 0, 10]]), noCollar);
    const wrong = score(truth, system([['a', 0, 10], ['a', 10, 20]]), noCollar);
    expect(quiet.unexplainedRate).toBe(0);
    expect(wrong.unexplainedRate).toBe(0);
    expect(quiet.scoredMs).toBe(10 * second);
    expect(quiet.excludedRate).toBeCloseTo(0.5, 6);
  });

  it('reports recall per person, so one loud speaker cannot carry the score', () => {
    const result = score(
      reference([
        ['loud', 0, 90],
        ['quiet', 90, 100],
      ]),
      system([['a', 0, 100]]),
      noCollar,
    );
    const quiet = result.perPerson.find((person) => person.person === 'quiet');
    expect(quiet?.recall).toBe(0);
    // 90% of the audio is right, and the harness still has to show that one of
    // the two people was never found.
    expect(result.unexplainedRate).toBeCloseTo(0.1, 6);
  });

  it('forgives boundary jitter at the collar but not a wrong speaker', () => {
    const truth = reference([
      ['boris', 0, 10],
      ['vova', 10, 20],
    ]);
    const jittered = system([
      ['a', 0, 10.2],
      ['b', 10.2, 20],
    ]);
    expect(score(truth, jittered, { collarMs: 250 }).unexplainedRate).toBe(0);
    expect(score(truth, jittered, noCollar).unexplainedRate).toBeGreaterThan(0);

    const swapped = system([['b', 0, 10], ['a', 10, 20]]);
    // Reversing the two clusters is still a perfect relabelling.
    expect(score(truth, swapped, { collarMs: 250 }).unexplainedRate).toBe(0);
    const merged = system([['a', 0, 20]]);
    expect(score(truth, merged, { collarMs: 250 }).unexplainedRate).toBeGreaterThan(0.4);
  });

  it('reports the collar sweep so a boundary-only result cannot hide', () => {
    const truth = reference([
      ['boris', 0, 10],
      ['vova', 10, 20],
    ]);
    const sweep = collarSensitivity(truth, system([['a', 0, 10.2], ['b', 10.2, 20]]));
    expect(sweep.map((row) => row.collarMs)).toEqual([0, 250, 500]);
    expect(sweep[0].unexplainedRate).toBeGreaterThan(sweep[1].unexplainedRate);
  });

  it('scores an empty system as everything missed rather than as nothing wrong', () => {
    const result = score(reference([['boris', 0, 10]]), [], noCollar);
    expect(result.unexplainedRate).toBe(1);
    expect(result.systemSpeakers).toBe(0);
  });
});
