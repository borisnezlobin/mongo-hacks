import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { durationHelpersSource, msToClock, secondsToClock } from './format';
import { REVIEW_PAGE_HTML } from './page';

/** The 48-minute recording. Nothing derived from it can be longer than it. */
const RECORDING_MS = 2_901_950;

describe('durations carry their unit', () => {
  it('formats milliseconds as the time a human would recognise', () => {
    expect(msToClock(753_730)).toBe('12m34s');
    expect(msToClock(9_000)).toBe('9s');
    expect(msToClock(60_000)).toBe('1m00s');
  });

  it('formats seconds separately, and does not treat them as milliseconds', () => {
    expect(secondsToClock(457.5)).toBe('7m38s');
    expect(secondsToClock(9)).toBe('9s');
  });

  it('never confuses the two: the same number reads differently by unit', () => {
    // This is the whole bug. 753730 as ms is 12m34s; as seconds it is 12562m10s,
    // which is what the speaker picker showed for a 48-minute recording.
    expect(msToClock(753_730)).not.toBe(secondsToClock(753_730));
    expect(secondsToClock(753_730)).toBe('12562m10s');
  });

  it('reports a duration inside the recording for every plausible speaking total', () => {
    // A duration longer than the recording is always a bug, whatever produced
    // it. Cheap, general, and it fails loudly on a unit slip.
    for (const ms of [0, 1_000, 753_730, RECORDING_MS]) {
      const minutes = Number(msToClock(ms).replace(/m.*/, '').replace(/s$/, '0'));
      expect(minutes).toBeLessThanOrEqual(Math.ceil(RECORDING_MS / 60_000));
    }
  });

  it('survives nonsense rather than printing NaN at him', () => {
    expect(msToClock(Number.NaN)).toBe('0s');
    expect(secondsToClock(-5)).toBe('0s');
  });
});

describe('the page uses those helpers and declares nothing twice', () => {
  it('ships exactly one definition of each duration helper', () => {
    expect(durationHelpersSource()).toContain('const msToClock');
    expect((REVIEW_PAGE_HTML.match(/const msToClock/g) ?? [])).toHaveLength(1);
    expect((REVIEW_PAGE_HTML.match(/const secondsToClock/g) ?? [])).toHaveLength(1);
  });

  it('declares no function name twice in the page script', () => {
    // The bug was two `function clock` declarations: the later one hoists over
    // the earlier and every call site silently changes meaning. No test asserted
    // anything, because nothing threw.
    const script = REVIEW_PAGE_HTML.slice(REVIEW_PAGE_HTML.indexOf('<script>'));
    const names = [...script.matchAll(/^function\s+([A-Za-z0-9_$]+)\s*\(/gm)].map((match) => match[1]);
    const seen = new Set<string>();
    const duplicated = names.filter((name) => (seen.has(name) ? true : (seen.add(name), false)));
    expect(duplicated).toEqual([]);
  });

  it('has no leftover call to the ambiguous helper', () => {
    expect(/[^a-zA-Z]clock\(/.test(REVIEW_PAGE_HTML)).toBe(false);
  });
});

describe('the page template survives editing', () => {
  it('has no backtick inside the template body', async () => {
    // page.ts is one String.raw template, so a backtick anywhere inside it —
    // most often quoting an identifier in a comment — silently terminates the
    // template. tsc catches it but points at the wrong line, and it has cost
    // three separate debugging detours. Fail here instead, with a reason.
    // Backticks in the file header, before the template opens, are harmless.
    const source = await readFile('server/review/page.ts', 'utf8');
    const opens = source.indexOf('String.raw`') + 'String.raw`'.length;
    const closes = source.lastIndexOf('`');
    expect(opens).toBeGreaterThan(0);
    expect(closes).toBeGreaterThan(opens);
    const body = source.slice(opens, closes);
    const strays = [...body.matchAll(/`/g)].map((match) => body.slice(Math.max(0, match.index - 50), match.index + 20));
    expect(strays, 'a backtick inside the template ends it early').toEqual([]);
  });
});
