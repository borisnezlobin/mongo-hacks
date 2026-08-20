import { describe, expect, it } from 'vitest';
import { missingFixtureNotice } from '../fixtures/real-audio';
import { dormReference, ninePmReference } from './ground-truth';
import { referenceOverlapMs, score } from './scoring';

/**
 * These do not test the ground truth's *content* -- nothing in a test file can
 * know who was talking. They test the properties that make it usable as a
 * reference at all, because each of these has already been broken once while it
 * was being built: a reference that does not score itself at zero, spans that
 * overlap each other, excluded time that quietly disappears, or a coverage
 * figure that stops matching the spans underneath it.
 */

const dorm = dormReference();
const ninePm = ninePmReference();

describe.skipIf(!ninePm)('dorm-9pm reference', () => {
  it('scores against itself at zero', () => {
    const result = score(ninePm!, ninePm!.spans.map((span) => ({ ...span })));
    expect(result.unexplainedRate).toBe(0);
    expect(result.der).toBe(0);
  });

  it('holds exactly the three people who were in the room', () => {
    expect(new Set(ninePm!.spans.map((span) => span.speaker))).toEqual(
      new Set(['Joshua', 'Boris', 'Tarun']),
    );
    expect(ninePm!.truePeople).toBe(3);
  });
});

describe.skipIf(!dorm)('dorm-40min ground truth', () => {
  it('scores against itself at zero', () => {
    const result = score(dorm!, dorm!.spans.map((span) => ({ ...span })));
    expect(result.unexplainedRate).toBe(0);
    expect(result.der).toBe(0);
  });

  it('says how many people it does not cover', () => {
    const scored = new Set(dorm!.spans.map((span) => span.speaker));
    expect(dorm!.truePeople).toBe(7);
    // Fewer people in the reference than in the room is the expected state.
    // More would mean one person has been split into two identities, which
    // would silently penalise a system that got them right.
    expect(scored.size).toBeLessThan(dorm!.truePeople);
    expect(scored.size).toBe(dorm!.meta.coverage.people_scored);
  });

  it('keeps its coverage figures honest against its own spans', () => {
    const scoredMs = dorm!.spans.reduce((sum, span) => sum + (span.end_ms - span.start_ms), 0);
    expect(scoredMs / 1000).toBeCloseTo(dorm!.meta.coverage.scored_speech_s, 0);
    const excludedMs = dorm!.excluded.reduce((sum, span) => sum + (span.end_ms - span.start_ms), 0);
    // Withheld plus scored has to be all of the diarized speech. If it is not,
    // some speech has gone missing from the artifact rather than been withheld,
    // and the excluded fraction the harness prints is a lie.
    expect((scoredMs + excludedMs) / 1000).toBeCloseTo(dorm!.meta.coverage.diarized_speech_s, 0);
  });

  it('only scores voices the builder marked high confidence', () => {
    const scored = new Set(dorm!.spans.map((span) => span.speaker));
    for (const person of dorm!.meta.people) {
      expect(scored.has(person.id)).toBe(person.confidence === 'high');
    }
  });

  it('never has two scored people speaking in the same instant', () => {
    // Not a claim that the room was orderly -- it was not. It is a claim about
    // this artifact: overlap between two scored people would be double-counted
    // by every metric, so the overlapped stretches belong in `excluded`.
    expect(referenceOverlapMs(dorm!)).toBe(0);
  });

  it('backs every name with quotable evidence', () => {
    for (const person of dorm!.meta.people) {
      if (!person.name) continue;
      const named = (person as unknown as { named_from?: { quote: string; at: number }[] }).named_from;
      // Either a line somebody said, at a timestamp anyone can play, or a
      // stated cosine against the recording whose people the owner named. A
      // name with neither is a guess wearing a label.
      expect(named?.length ?? 0).toBeGreaterThan(0);
      for (const anchor of named ?? []) {
        expect(anchor.quote.trim().length).toBeGreaterThan(0);
        expect(anchor.at).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('never gives one name to two voices', () => {
    const names = dorm!.meta.people.map((person) => person.name).filter(Boolean);
    // Two voices called Tarun would mean the reference is asserting one person
    // is two, which penalises exactly the system that got them right.
    expect(new Set(names).size).toBe(names.length);
  });
});

describe.skipIf(dorm)('dorm-40min ground truth is absent', () => {
  it('says so instead of passing silently', () => {
    console.warn(missingFixtureNotice('dorm-40min.wav'));
    expect(dorm).toBeNull();
  });
});
