import { describe, expect, it } from 'vitest';
import { LANDMARKS } from './landmarks';
import {
  conflictsWithLandmarks,
  landmarkIdentity,
  latestSpeakerRulings,
  mergedLandmarks,
  ownerLandmarks,
  ownerSpans,
  ownerTranscriptFixes,
  ownerBoundaries,
  scoreBoundaries,
  splitLandmarks,
  splitSpans,
  identityLandmarks,
  resolvedSeconds,
} from './owner-corrections';

interface Raw {
  corrections: Record<string, unknown>[];
}

function ruling(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'c1',
    recording: 'dorm-40min',
    utterance_id: 'u1',
    at_ms: 24_500,
    end_ms: 25_640,
    original_text: "Oh shit, I'm Ukrainian.",
    original_speaker_name: 'Vova',
    asserts: ['speaker'],
    speaker: { person_id: 'dorm-40min-p6', name: 'Volva' },
    created_at: '2026-08-18T10:00:00.000Z',
    ...overrides,
  };
}

const file = (corrections: Record<string, unknown>[]) => ({ corrections }) as Raw;

describe('what a correction is worth as ground truth', () => {
  it('carries the owner name into an identity the pairwise check can use', () => {
    expect(landmarkIdentity(ruling() as never)).toBe('volva');
  });

  it('refuses to treat "Unnamed voice" as an identity, and falls back to the stable id', () => {
    // Six of the eight people in this recording carry the placeholder. Taking
    // it at face value would assert they are all one person.
    const unnamed = ruling({ speaker: { person_id: 'dorm-40min-p0', name: 'Unnamed voice' } });
    expect(landmarkIdentity(unnamed as never)).toBe('dorm-40min-p0');
  });

  it('folds case so a corrected "Volva" is the same person as the landmark file\'s "volva"', () => {
    const merged = mergedLandmarks('dorm-40min', file([ruling()]) as never);
    const identities = new Set(merged.map((landmark) => landmark.person).filter(Boolean));
    expect(identities.has('volva')).toBe(true);
    expect(identities.has('Volva')).toBe(false);
  });

  it('adds to the handwritten landmarks rather than replacing them', () => {
    const handwritten = LANDMARKS.filter((landmark) => landmark.recording === 'dorm-40min').length;
    expect(mergedLandmarks('dorm-40min', file([ruling()]) as never)).toHaveLength(handwritten + 1);
  });
});

describe('the latest ruling wins for reading, and the rest is still in the log', () => {
  it('takes the most recent attribution for a line', () => {
    const early = ruling({ id: 'a', speaker: { person_id: 'p6', name: 'Vova' }, created_at: '2026-08-18T09:00:00.000Z' });
    const late = ruling({ id: 'b', speaker: { person_id: 'p6', name: 'Volva' }, created_at: '2026-08-18T11:00:00.000Z' });
    const rulings = latestSpeakerRulings('dorm-40min', file([late, early]) as never);
    expect(rulings).toHaveLength(1);
    expect(rulings[0].id).toBe('b');
  });

  it('ignores rulings from a different recording', () => {
    expect(latestSpeakerRulings('dorm-9pm', file([ruling()]) as never)).toEqual([]);
  });
});

describe('sampling, so the quadratic pairwise check stays readable', () => {
  it('caps landmarks per speaker and spreads them across the recording', () => {
    const many = Array.from({ length: 100 }, (_, i) =>
      ruling({ id: `c${i}`, utterance_id: `u${i}`, at_ms: i * 10_000, end_ms: i * 10_000 + 1_000 }));
    const landmarks = ownerLandmarks('dorm-40min', { perSpeaker: 5, file: file(many) as never });
    expect(landmarks).toHaveLength(5);
    // First and last must survive, or a merge late in the recording is invisible.
    expect(landmarks[0].at_ms).toBe(0);
    expect(landmarks[4].at_ms).toBe(990_000);
  });

  it('keeps every ruling when there are fewer than the cap', () => {
    expect(ownerLandmarks('dorm-40min', { perSpeaker: 12, file: file([ruling()]) as never })).toHaveLength(1);
  });
});

describe('the two references corrections feed', () => {
  it('produces spans for the diarization reference', () => {
    expect(ownerSpans('dorm-40min', file([ruling()]) as never)).toEqual([
      { speaker: 'volva', start_ms: 24_500, end_ms: 25_640 },
    ]);
  });

  it('keeps transcript fixes separate, and only where the words actually changed', () => {
    const changed = ruling({ id: 'x', utterance_id: 'u2', asserts: ['text'], original_text: 'from Poland', text: 'from Palo Alto' });
    const unchanged = ruling({ id: 'y', utterance_id: 'u3', asserts: ['text'], original_text: 'same', text: 'same' });
    const fixes = ownerTranscriptFixes('dorm-40min', file([changed, unchanged]) as never);
    expect(fixes).toHaveLength(1);
    expect(fixes[0]).toMatchObject({ was: 'from Poland', is: 'from Palo Alto' });
  });
});

describe('disagreement with the handwritten landmarks', () => {
  it('reports a correction that contradicts a positive landmark instead of resolving it', () => {
    // "I'm Boris." at 19_360-20_400 is in landmarks.ts as person 'boris'.
    const contradiction = ruling({ utterance_id: 'u9', at_ms: 19_360, end_ms: 20_400, speaker: { person_id: 'p6', name: 'Volva' } });
    const conflicts = conflictsWithLandmarks('dorm-40min', file([contradiction]) as never);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].detail).toMatch(/landmark says boris/);
  });

  it('stays quiet when the correction agrees with the landmark', () => {
    const agreement = ruling({ utterance_id: 'u9', at_ms: 19_360, end_ms: 20_400, speaker: { person_id: 'p1', name: 'Boris' } });
    expect(conflictsWithLandmarks('dorm-40min', file([agreement]) as never)).toEqual([]);
  });

  it('does not treat an unnamed confirmation as disagreeing with a named landmark', () => {
    const unnamed = ruling({ utterance_id: 'u9', at_ms: 19_360, end_ms: 20_400, speaker: { person_id: 'p1', name: 'Unnamed voice' } });
    expect(conflictsWithLandmarks('dorm-40min', file([unnamed]) as never)).toEqual([]);
  });
});

function splitFile(parts: { start_ms: number; end_ms: number; name: string }[], boundaries: { from_ms: number; to_ms: number }[]) {
  return {
    corrections: [],
    splits: [{
      id: 's1', kind: 'split', recording: 'dorm-40min', utterance_id: 'u1',
      at_ms: parts[0].start_ms, end_ms: parts[parts.length - 1].end_ms,
      original_text: 'whole line', original_speaker_name: 'Boris',
      boundaries,
      parts: parts.map((part) => ({ start_ms: part.start_ms, end_ms: part.end_ms, text: part.name + ' bit', speaker: { person_id: null, name: part.name } })),
      created_at: '2026-08-18T10:00:00.000Z',
    }],
  } as never;
}

const threeParts = splitFile(
  [{ start_ms: 19_360, end_ms: 20_800, name: 'Boris' },
   { start_ms: 20_840, end_ms: 21_520, name: 'Volva' },
   { start_ms: 21_960, end_ms: 24_140, name: 'Boris' }],
  [{ from_ms: 20_800, to_ms: 20_840 }, { from_ms: 21_520, to_ms: 21_960 }],
);

describe('a split claims a boundary diarization missed', () => {
  it('yields one claim per cut, carrying the silence it sits in', () => {
    const claims = ownerBoundaries('dorm-40min', threeParts);
    expect(claims).toHaveLength(2);
    expect(claims[0]).toMatchObject({ from_ms: 20_800, to_ms: 20_840, before: 'boris', after: 'volva' });
    expect(claims[1]).toMatchObject({ from_ms: 21_520, to_ms: 21_960, before: 'volva', after: 'boris' });
  });

  it('counts a boundary as missed when one turn covers the whole line', () => {
    // This is pyannote's real output for the line: 18.22-24.38 as one turn,
    // nothing nested inside. Neither cut has any counterpart in it.
    const oneTurn = [{ speaker: 'SPEAKER_04', start_ms: 18_222, end_ms: 24_382 }];
    const report = scoreBoundaries(ownerBoundaries('dorm-40min', threeParts), oneTurn);
    expect(report).toMatchObject({ total: 2, found: 0 });
    expect(report.missed).toHaveLength(2);
  });

  it('counts a boundary as found when the system changes speaker inside the silence', () => {
    const segmented = [
      { speaker: 'A', start_ms: 18_222, end_ms: 20_810 },
      { speaker: 'B', start_ms: 20_830, end_ms: 21_530 },
      { speaker: 'A', start_ms: 21_950, end_ms: 24_382 },
    ];
    expect(scoreBoundaries(ownerBoundaries('dorm-40min', threeParts), segmented)).toMatchObject({ total: 2, found: 2 });
  });

  it('does not credit a boundary that is merely nearby', () => {
    const wrongPlace = [
      { speaker: 'A', start_ms: 18_222, end_ms: 19_000 },
      { speaker: 'B', start_ms: 19_000, end_ms: 24_382 },
    ];
    expect(scoreBoundaries(ownerBoundaries('dorm-40min', threeParts), wrongPlace).found).toBe(0);
  });

  it('tolerates jitter inside the collar, because the exact instant is unknowable', () => {
    const slightlyOff = [
      { speaker: 'A', start_ms: 18_222, end_ms: 20_650 },
      { speaker: 'B', start_ms: 20_650, end_ms: 24_382 },
    ];
    expect(scoreBoundaries(ownerBoundaries('dorm-40min', threeParts), slightlyOff, 250).found).toBe(1);
    expect(scoreBoundaries(ownerBoundaries('dorm-40min', threeParts), slightlyOff, 10).found).toBe(0);
  });

  it('also turns each part into an ordinary landmark, so the merge check sees it', () => {
    const landmarks = splitLandmarks('dorm-40min', threeParts);
    expect(landmarks).toHaveLength(3);
    expect(landmarks.map((landmark) => landmark.person)).toEqual(['boris', 'volva', 'boris']);
  });

  it('and into spans, because landmarks say nothing about coverage', () => {
    expect(splitSpans('dorm-40min', threeParts)).toEqual([
      { speaker: 'boris', start_ms: 19_360, end_ms: 20_800 },
      { speaker: 'volva', start_ms: 20_840, end_ms: 21_520 },
      { speaker: 'boris', start_ms: 21_960, end_ms: 24_140 },
    ]);
  });

  it('drops a retracted split entirely', () => {
    const retracted = { ...(threeParts as never as { splits: unknown[] }) };
    retracted.splits = [
      ...(threeParts as never as { splits: Record<string, unknown>[] }).splits,
      { id: 'r', kind: 'retraction', recording: 'dorm-40min', utterance_id: 'u1', boundaries: [], parts: [], created_at: '2026-08-18T11:00:00.000Z' },
    ];
    expect(ownerBoundaries('dorm-40min', retracted as never)).toEqual([]);
    expect(splitLandmarks('dorm-40min', retracted as never)).toEqual([]);
  });
});

describe('a retracted correction reaches no reference', () => {
  it('disappears from the speaker rulings', () => {
    const withdrawn = file([
      ruling({ id: 'a', created_at: '2026-08-18T10:00:00.000Z' }),
      { id: 'r', kind: 'retraction', recording: 'dorm-40min', utterance_id: 'u1', at_ms: 24_500, end_ms: 25_640, original_text: '', original_speaker_name: null, asserts: [], retracts: ['speaker'], created_at: '2026-08-18T11:00:00.000Z' },
    ]);
    expect(latestSpeakerRulings('dorm-40min', withdrawn as never)).toEqual([]);
    expect(ownerLandmarks('dorm-40min', { file: withdrawn as never })).toEqual([]);
  });
});

describe('answers about voices become constraints', () => {
  const spanA = { start_ms: 1_000, end_ms: 9_000 };
  const spanB = { start_ms: 50_000, end_ms: 60_000 };
  const spanC = { start_ms: 80_000, end_ms: 90_000 };
  const answers = (rows: { label_a: string; label_b: string; answer: string; compared?: unknown }[]) => ({
    corrections: [],
    identity_answers: rows.map((row, i) => ({
      ...row, id: 'a' + i, question_id: 'q' + i, recording: 'dorm-40min',
      worth_seconds: 457.5, created_at: '2026-08-19T0' + i + ':00:00.000Z',
    })),
  }) as never;

  it('groups both stretches under one identity when he says same', () => {
    const landmarks = identityLandmarks('dorm-40min', [], answers([
      { label_a: '0:E', label_b: '950:E', answer: 'same', compared: { a: spanA, b: spanB } },
    ]));
    expect(new Set(landmarks.map((landmark) => landmark.person)).size).toBe(1);
    expect(landmarks).toHaveLength(2);
  });

  it('keeps them apart when he says different', () => {
    const landmarks = identityLandmarks('dorm-40min', [], answers([
      { label_a: '0:A', label_b: '950:E', answer: 'different', compared: { a: spanC, b: spanB } },
    ]));
    expect(new Set(landmarks.map((landmark) => landmark.person)).size).toBe(2);
  });

  it('never stamps two identities on the same span', () => {
    // Every question here shares one rival, so per-question identities put
    // contradictory names on identical spans and demanded a span differ
    // from itself.
    const landmarks = identityLandmarks('dorm-40min', [], answers([
      { label_a: '0:E', label_b: '950:E', answer: 'same', compared: { a: spanA, b: spanB } },
      { label_a: '0:A', label_b: '950:E', answer: 'different', compared: { a: spanC, b: spanB } },
    ]));
    const bySpan = new Map<string, Set<string>>();
    for (const landmark of landmarks) {
      const key = landmark.at_ms + ':' + landmark.end_ms;
      bySpan.set(key, (bySpan.get(key) ?? new Set()).add(landmark.person!));
    }
    expect([...bySpan.values()].filter((names) => names.size > 1)).toEqual([]);
  });

  it('anchors constraints to audio, never to the retired cluster names', () => {
    // 0:E and 950:E are chunk-scoped labels from a provider we no longer run.
    // A constraint keyed to them rots the next time anything upstream changes.
    const landmarks = identityLandmarks('dorm-40min', [], answers([
      { label_a: '0:E', label_b: '950:E', answer: 'same', compared: { a: spanA, b: spanB } },
    ]));
    for (const landmark of landmarks) {
      expect(landmark.person).not.toMatch(/0:E|950:E/);
      expect(landmark.person).toMatch(/^voice@/);
    }
  });

  it('produces the same constraints when the question set is gone entirely', () => {
    const file = answers([{ label_a: '0:E', label_b: '950:E', answer: 'same', compared: { a: spanA, b: spanB } }]);
    expect(identityLandmarks('dorm-40min', [], file)).toEqual(identityLandmarks('dorm-40min', [], file));
    expect(identityLandmarks('dorm-40min', [], file)).toHaveLength(2);
  });

  it('constrains only the two stretches he heard, not every clip on each side', () => {
    // The three clips on one side are one voice only according to the retired
    // clustering — and these clusters are in the question set precisely because
    // that clustering called them impure. Grouping them answers the question
    // being asked.
    const landmarks = identityLandmarks('dorm-40min', [], answers([
      { label_a: '0:E', label_b: '950:E', answer: 'same', compared: { a: spanA, b: spanB } },
    ]));
    expect(landmarks.map((landmark) => landmark.at_ms).sort((a, b) => a - b)).toEqual([1_000, 50_000]);
  });

  it('ignores an answer that recorded no spans, rather than guessing them', () => {
    const legacy = answers([{ label_a: '0:E', label_b: '950:E', answer: 'same' }]);
    expect(identityLandmarks('dorm-40min', [], legacy)).toEqual([]);
  });

  it('treats "cannot tell" as a real answer that constrains nothing', () => {
    const file = answers([{ label_a: '0:E', label_b: '950:E', answer: 'unsure', compared: { a: spanA, b: spanB } }]);
    expect(identityLandmarks('dorm-40min', [], file)).toEqual([]);
    expect(resolvedSeconds('dorm-40min', file)).toBe(0);
  });

  it('counts the speech an answer takes out of the dark', () => {
    expect(resolvedSeconds('dorm-40min', answers([
      { label_a: '0:E', label_b: '950:E', answer: 'same', compared: { a: spanA, b: spanB } },
    ]))).toBe(457.5);
  });
});
