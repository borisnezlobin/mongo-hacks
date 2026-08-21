import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  assertCorrectionsPathIsIgnored,
  correctionsPath,
  currentRulings,
  findConflicts,
  mutateCorrections,
  readCorrections,
  resolveLine,
  rosterFor,
  skippedLines,
  assertedDimensions,
  findSplitConflicts,
  validateSplit,
  type Correction,
  type SplitPart,
  type CorrectionsFile,
} from './corrections';

const dir = mkdtempSync(join(tmpdir(), 'amelia-corrections-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function correction(overrides: Partial<Correction>): Correction {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    recording: 'dorm-40min',
    utterance_id: 'u1',
    at_ms: 19_360,
    end_ms: 20_400,
    original_text: "I'm Boris.",
    original_speaker_id: 'p1',
    original_speaker_name: 'Boris',
    asserts: ['speaker'],
    created_at: '2026-08-18T10:00:00.000Z',
    ...overrides,
  };
}

function file(corrections: Correction[]): CorrectionsFile {
  return { version: 1, privacy: '', corrections, person_renames: [], splits: [], identity_answers: [] };
}

describe('the corrections path', () => {
  it('defaults somewhere git ignores, because every record quotes real people', () => {
    expect(correctionsPath()).toBe(resolve(process.cwd(), 'eval/real/corrections.json'));
    expect(() => assertCorrectionsPathIsIgnored()).not.toThrow();
  });

  it('refuses to write personal data to a tracked path', () => {
    expect(() => assertCorrectionsPathIsIgnored(resolve('eval/corrections-oops.json'))).toThrow(/does not ignore/);
  });

  it('allows a path outside the repository, which git cannot see at all', () => {
    expect(() => assertCorrectionsPathIsIgnored(join(dir, 'anywhere.json'))).not.toThrow();
  });
});

describe('deltas, not a rewritten transcript', () => {
  it('distinguishes an untouched line from one confirmed correct', () => {
    const confirmed = correction({ utterance_id: 'u1', asserts: ['speaker', 'text'], speaker: { person_id: 'p1', name: 'Boris' }, text: "I'm Boris." });
    const history = currentRulings(file([confirmed]));
    expect(resolveLine(history.get('u1') ?? [])?.asserted).toEqual(new Set(['speaker', 'text']));
    // The line nobody looked at has no record at all, which is the whole point.
    expect(resolveLine(history.get('u2') ?? [])).toBeNull();
  });

  it('lets a later ruling win for reading without erasing the earlier one', async () => {
    const path = join(dir, 'log.json');
    await mutateCorrections((current) => ({
      file: { ...current, corrections: [correction({ speaker: { person_id: 'p6', name: 'Vova' } })] },
      result: null,
    }), path);
    await mutateCorrections((current) => ({
      file: {
        ...current,
        corrections: [...current.corrections, correction({ created_at: '2026-08-18T11:00:00.000Z', speaker: { person_id: 'p6', name: 'Volva' } })],
      },
      result: null,
    }), path);

    const stored = readCorrections(path);
    expect(stored.corrections).toHaveLength(2);
    expect(resolveLine(stored.corrections)?.speaker?.name).toBe('Volva');
  });

  it('refuses to overwrite a file it cannot parse rather than starting fresh', () => {
    const path = join(dir, 'broken.json');
    writeFileSync(path, '{ not json');
    expect(() => readCorrections(path)).toThrow(/unreadable/);
  });
});

describe('conflicts are surfaced, not resolved', () => {
  it('does NOT treat amending his own attribution as a conflict', () => {
    // This blocked the owner mid-session: having ruled on a line once, he could
    // not rule on it again. Changing your mind after listening again is the
    // point of the page, and supersession is not disagreement.
    const existing = file([correction({ id: 'first', speaker: { person_id: 'p1', name: 'Boris' } })]);
    const conflicts = findConflicts(
      { recording: 'dorm-40min', utterance_id: 'u1', at_ms: 19_360, end_ms: 20_400, asserts: ['speaker'], speaker: { person_id: 'p6', name: 'Volva' } },
      existing,
    );
    expect(conflicts).toEqual([]);
  });

  it('does NOT block confirming a line whose text he already edited', () => {
    // The exact sequence that stopped him: edit the words, then try to confirm.
    const edited = file([correction({ id: 'edit', asserts: ['text'], text: 'Boris.' })]);
    const conflicts = findConflicts(
      { recording: 'dorm-40min', utterance_id: 'u1', at_ms: 19_360, end_ms: 20_400, asserts: ['speaker', 'text'], speaker: { person_id: 'p1', name: 'Boris' }, text: "I'm Boris." },
      edited,
    );
    expect(conflicts).toEqual([]);
  });

  it('treats a re-affirmation of the same name as agreement, not conflict', () => {
    const existing = file([correction({ speaker: { person_id: 'p1', name: 'Boris' } })]);
    const conflicts = findConflicts(
      { recording: 'dorm-40min', utterance_id: 'u1', at_ms: 19_360, end_ms: 20_400, asserts: ['speaker'], speaker: { person_id: 'p1', name: 'boris ' } },
      existing,
    );
    expect(conflicts).toEqual([]);
  });

  it('spots a correction contradicting a positive landmark over the same time', () => {
    const conflicts = findConflicts(
      { recording: 'dorm-40min', utterance_id: 'u1', at_ms: 19_400, end_ms: 20_300, asserts: ['speaker'], speaker: { person_id: 'p6', name: 'Volva' } },
      file([]),
      [{ recording: 'dorm-40min', at_ms: 19_360, end_ms: 20_400, quote: "I'm Boris.", person: 'boris' }],
      rosterFor([{ name: 'Boris' }, { name: 'Volva' }]),
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe('landmark');
  });

  it('spots a correction contradicting a negative landmark', () => {
    const conflicts = findConflicts(
      { recording: 'dorm-40min', utterance_id: 'u9', at_ms: 20_900, end_ms: 21_500, asserts: ['speaker'], speaker: { person_id: 'p1', name: 'Boris' } },
      file([]),
      [{ recording: 'dorm-40min', at_ms: 20_840, end_ms: 21_960, quote: 'Where are you from?', notPerson: 'boris' }],
      rosterFor([{ name: 'Boris' }]),
    );
    expect(conflicts[0].detail).toMatch(/NOT boris/);
  });

  it('does not flag a landmark that does not overlap in time', () => {
    const conflicts = findConflicts(
      { recording: 'dorm-40min', utterance_id: 'u1', at_ms: 100_000, end_ms: 101_000, asserts: ['speaker'], speaker: { person_id: 'p6', name: 'Volva' } },
      file([]),
      [{ recording: 'dorm-40min', at_ms: 19_360, end_ms: 20_400, quote: "I'm Boris.", person: 'boris' }],
    );
    expect(conflicts).toEqual([]);
  });
});

const part = (start: number, end: number, name: string, id: string | null = null): SplitPart => ({
  start_ms: start, end_ms: end, text: 'x', speaker: { person_id: id, name },
});

describe('taking a ruling back', () => {
  const asserted = correction({ id: 'a', asserts: ['speaker', 'text'], speaker: { person_id: 'p1', name: 'Boris' }, text: 'hello', created_at: '2026-08-18T10:00:00.000Z' });
  const retraction = correction({ id: 'r', kind: 'retraction', asserts: [], retracts: ['speaker', 'text'], created_at: '2026-08-18T11:00:00.000Z' });

  it('leaves the line as though it had never been ruled on', () => {
    const resolved = resolveLine([asserted, retraction]);
    expect(resolved?.asserted.size).toBe(0);
    expect(resolved?.retracted).toBe(true);
    expect(resolved?.speaker).toBeUndefined();
  });

  it('keeps the withdrawn record in the log', () => {
    // Append-only: knowing he took something back is information. A line he
    // ruled on and withdrew is not the same object as one nobody touched.
    expect([asserted, retraction]).toHaveLength(2);
  });

  it('takes back only the dimension named', () => {
    const partial = correction({ id: 'r2', kind: 'retraction', asserts: [], retracts: ['text'], created_at: '2026-08-18T11:00:00.000Z' });
    const resolved = resolveLine([asserted, partial]);
    expect([...resolved!.asserted]).toEqual(['speaker']);
    expect(resolved?.speaker?.name).toBe('Boris');
  });

  it('lets him rule again after taking it back', () => {
    const again = correction({ id: 'b', asserts: ['speaker'], speaker: { person_id: 'p6', name: 'Volva' }, created_at: '2026-08-18T12:00:00.000Z' });
    const resolved = resolveLine([asserted, retraction, again]);
    expect(resolved?.speaker?.name).toBe('Volva');
    expect(resolved?.retracted).toBe(false);
  });

  it('reports assertedDimensions so a retraction knows what there is to withdraw', () => {
    expect(assertedDimensions([asserted]).sort()).toEqual(['speaker', 'text']);
    expect(assertedDimensions([asserted, retraction])).toEqual([]);
  });
});

describe('a split is a claim that the speaker changed', () => {
  it('refuses a cut whose two sides are the same person', () => {
    // Such a cut asserts a change that did not happen, and would become a
    // false negative in the only reference that measures missed boundaries.
    expect(validateSplit([part(0, 100, 'Boris'), part(200, 300, 'Boris')])).toMatch(/did not happen/);
  });

  it('refuses when the same person arrives by id under two spellings', () => {
    expect(validateSplit([part(0, 100, 'Vova', 'p6'), part(200, 300, 'Volva', 'p6')])).toMatch(/did not happen/);
  });

  it('allows a speaker to come back after somebody else', () => {
    expect(validateSplit([part(0, 100, 'Boris'), part(200, 300, 'Volva'), part(400, 500, 'Boris')])).toBeNull();
  });

  it('requires a speaker on every part', () => {
    expect(validateSplit([part(0, 100, 'Boris'), part(200, 300, '')])).toMatch(/needs a speaker/);
  });

  it('needs at least two parts', () => {
    expect(validateSplit([part(0, 100, 'Boris')])).toMatch(/at least two/);
  });
});

describe('landmark names are only compared when this conversation knows them', () => {
  const roster = rosterFor([{ name: 'Boris' }, { name: 'Vova' }]);

  it('stays silent when the landmark spells a name the roster does not have', () => {
    // landmarks.ts writes "volva"; the pipeline guessed "Vova". One man. Left
    // alone, this flagged a contradiction on every line he speaks.
    const conflicts = findConflicts(
      { recording: 'dorm-40min', utterance_id: 'u1', at_ms: 24_500, end_ms: 25_640, asserts: ['speaker'], speaker: { person_id: 'p6', name: 'Vova' } },
      file([]),
      [{ recording: 'dorm-40min', at_ms: 24_500, end_ms: 25_640, quote: "Oh shit, I'm Ukrainian.", person: 'volva' }],
      roster,
    );
    expect(conflicts).toEqual([]);
  });

  it('still flags a genuine disagreement between two names it knows', () => {
    const conflicts = findConflicts(
      { recording: 'dorm-40min', utterance_id: 'u1', at_ms: 19_360, end_ms: 20_400, asserts: ['speaker'], speaker: { person_id: 'p6', name: 'Vova' } },
      file([]),
      [{ recording: 'dorm-40min', at_ms: 19_360, end_ms: 20_400, quote: "I'm Boris.", person: 'Boris' }],
      roster,
    );
    expect(conflicts).toHaveLength(1);
  });

  it('picks the spelling up once he has renamed the person', () => {
    const renamed = rosterFor([{ name: 'Boris' }, { name: 'Vova' }], [{ to_name: 'Volva' }]);
    const conflicts = findConflicts(
      { recording: 'dorm-40min', utterance_id: 'u1', at_ms: 19_360, end_ms: 20_400, asserts: ['speaker'], speaker: { person_id: 'p1', name: 'Boris' } },
      file([]),
      [{ recording: 'dorm-40min', at_ms: 19_360, end_ms: 20_400, quote: 'x', person: 'volva' }],
      renamed,
    );
    expect(conflicts).toHaveLength(1);
  });

  it('flags a landmark that a cut runs straight through', () => {
    const conflicts = findSplitConflicts(
      {
        recording: 'dorm-40min', at_ms: 19_360, end_ms: 24_140,
        parts: [part(19_360, 20_800, 'Boris', 'p1'), part(20_840, 24_140, 'Vova', 'p6')],
      },
      [{ recording: 'dorm-40min', at_ms: 19_360, end_ms: 24_140, quote: 'whole line', person: 'Boris' }],
      roster,
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].detail).toMatch(/boundary inside it/);
  });
});


describe('a skip is information, not a ruling', () => {
  const skip = (over: Partial<Correction> = {}) => correction({
    id: 's1', kind: 'skip', asserts: [], speaker: undefined, text: undefined,
    created_at: '2026-08-20T10:00:00.000Z', ...over,
  });

  it('leaves the line reading as untouched, so it reaches no reference', () => {
    // "I looked at this and could not answer" must never become evidence about
    // who spoke. It asserts nothing and is stored to be found, not scored.
    expect(resolveLine([skip()])).toBeNull();
  });

  it('does not mark a line as retracted either', () => {
    const resolved = resolveLine([skip()]);
    expect(resolved).toBeNull();
  });

  it('cannot hide a real ruling made afterwards', () => {
    const ruled = correction({ id: 'a', asserts: ['speaker'], speaker: { person_id: 'p1', name: 'Boris' }, created_at: '2026-08-20T11:00:00.000Z' });
    expect(resolveLine([skip(), ruled])?.speaker?.name).toBe('Boris');
  });

  it('lists the lines he could not answer', () => {
    const listed = skippedLines(file([skip({ utterance_id: 'u7' })]), 'dorm-40min');
    expect([...listed.keys()]).toEqual(['u7']);
  });

  it('stops listing one he later came back and answered', () => {
    const listed = skippedLines(file([
      skip({ utterance_id: 'u7' }),
      correction({ id: 'later', utterance_id: 'u7', asserts: ['speaker'], speaker: { person_id: 'p1', name: 'Boris' }, created_at: '2026-08-20T12:00:00.000Z' }),
    ]), 'dorm-40min');
    expect([...listed.keys()]).toEqual([]);
  });

  it('keeps listing one whose only later record is another skip', () => {
    const listed = skippedLines(file([
      skip({ utterance_id: 'u7' }),
      skip({ id: 's2', utterance_id: 'u7', created_at: '2026-08-20T12:00:00.000Z' }),
    ]), 'dorm-40min');
    expect([...listed.keys()]).toEqual(['u7']);
  });

  it('ignores skips from a different recording', () => {
    expect([...skippedLines(file([skip({ recording: 'dorm-9pm' })]), 'dorm-40min').keys()]).toEqual([]);
  });
});

describe('splitting between two unnamed voices', () => {
  const part = (start: number, end: number, id: string | null, name: string) => ({
    start_ms: start, end_ms: end, text: 'x',
    speaker: { person_id: id, name },
  });

  it('accepts a cut between two different voices that share the placeholder name', () => {
    // What the owner actually did: split a line, picked Voice 1 for one half and
    // Voice 2 for the other. Both are called "Unnamed voice", and the cut was
    // refused as claiming a speaker change that did not happen.
    expect(validateSplit([
      part(0, 1000, 'p-1', 'Unnamed voice'),
      part(1000, 2000, 'p-2', 'Unnamed voice'),
    ])).toBeNull();
  });

  it('still refuses a cut with the same voice on both sides', () => {
    expect(validateSplit([
      part(0, 1000, 'p-1', 'Unnamed voice'),
      part(1000, 2000, 'p-1', 'Unnamed voice'),
    ])).toContain('did not happen');
  });

  it('still refuses two free-text speakers of the same name', () => {
    // No ids to distinguish them, so the name is all there is.
    expect(validateSplit([
      part(0, 1000, null, 'Tarun'),
      part(1000, 2000, null, 'tarun'),
    ])).toContain('did not happen');
  });
});
