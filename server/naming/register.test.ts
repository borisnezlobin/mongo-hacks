import { describe, expect, it } from 'vitest';
import type { AmeliaEvent, NameSuggestionEvent, UtteranceEvent } from '../../shared/contracts';
import { AmeliaBus } from '../lib/bus';
import { registerNameSuggestions } from './register';
import { hasRealFixture, missingFixtureNotice, readRealFixture } from '../../fixtures/real-audio';

const FIXTURE = 'dorm-9pm.diarize.json';

const CONVERSATION = 'c-dorm';

interface DiarizedSegment {
  speaker: string;
  start: number;
  end: number;
  text: string;
}

/**
 * The owner's real dorm recording, as the diarizing model labelled it.
 * Ground truth: A is Josh, C is the owner, G is Tarun. B/D/E/F are over-splits.
 */
function realSegments(): DiarizedSegment[] {
  return readRealFixture<{ segments: DiarizedSegment[] }>(FIXTURE).segments;
}

/** Replay a diarized transcript over the bus the way the audio session would. */
function replay(bus: AmeliaBus, segments: DiarizedSegment[]): void {
  segments.forEach((segment, index) => {
    const utteranceId = `seg_${index}`;
    const utterance: UtteranceEvent = {
      type: 'utterance',
      utterance_id: utteranceId,
      conversation_id: CONVERSATION,
      text: segment.text,
      start_ms: Math.round(segment.start * 1000),
      end_ms: Math.round(segment.end * 1000),
      is_final: true,
    };
    // Speaker attribution lands after the text, exactly as it does live.
    bus.emit(utterance);
    bus.emit({
      type: 'speaker_pending',
      conversation_id: CONVERSATION,
      session_speaker: segment.speaker,
      utterance_ids: [utteranceId],
      speech_ms: 0,
      provisional_speech_ms: 8_000,
      reason: 'gathering',
    });
  });
  bus.emit({
    type: 'conversation',
    conversation_id: CONVERSATION,
    ended_at: new Date(0).toISOString(),
  });
}

function collect(bus: AmeliaBus): NameSuggestionEvent[] {
  const seen: NameSuggestionEvent[] = [];
  bus.subscribe((event: AmeliaEvent) => {
    if (event.type === 'name_suggestion') seen.push(event);
  });
  return seen;
}

async function settle(): Promise<void> {
  // Suggestions are emitted from a microtask so they never interleave with the
  // dispatch of the utterance that produced them.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const notice = hasRealFixture(FIXTURE) ? '' : ` — ${missingFixtureNotice(FIXTURE)}`;

describe.skipIf(!hasRealFixture(FIXTURE))(`registerNameSuggestions${notice}`, () => {
  it('names Josh from a real overheard vocative, and credits the right voice', async () => {
    const bus = new AmeliaBus();
    registerNameSuggestions(bus);
    const suggestions = collect(bus);

    replay(bus, realSegments());
    await settle();

    const josh = suggestions.find((suggestion) => suggestion.name === 'Josh');
    expect(josh).toBeDefined();
    // Speaker A is Josh. Speaker C is the one who SAID "Also Josh tomorrow" —
    // crediting the speaker instead of the addressee is the obvious wrong answer.
    expect(josh?.session_speaker).toBe('A');
    expect(josh?.kind).toBe('vocative');
    expect(josh?.evidence).toMatch(/Josh/);
  });

  it('proposes nothing for the things in this conversation that are not people', async () => {
    const bus = new AmeliaBus();
    registerNameSuggestions(bus);
    const suggestions = collect(bus);

    replay(bus, realSegments());
    await settle();

    const names = suggestions.map((suggestion) => suggestion.name.toLowerCase());
    for (const notAPerson of ['luma', 'transit', 'haas', 'hotz', 'google', 'maps', 'cal']) {
      expect(names).not.toContain(notAPerson);
    }
  });

  it('stays quiet for a voice that already has a real name', async () => {
    const bus = new AmeliaBus();
    registerNameSuggestions(bus);
    const suggestions = collect(bus);

    bus.subscribe((event) => {
      if (event.type !== 'utterance') return;
      // Identity resolves speaker A to a person who is already called Josh.
      if (event.utterance_id !== 'seg_0') return;
      bus.emit({
        type: 'identity',
        conversation_id: CONVERSATION,
        person_id: 'A',
        name: 'Josh',
        utterance_ids: ['seg_0'],
        confidence: 'confirmed',
      });
    });

    replay(bus, realSegments());
    await settle();

    expect(suggestions.find((suggestion) => suggestion.name === 'Josh')).toBeUndefined();
  });

  it('does not re-propose the same name on every drain', async () => {
    const bus = new AmeliaBus();
    registerNameSuggestions(bus);
    const suggestions = collect(bus);

    replay(bus, realSegments());
    await settle();

    const joshes = suggestions.filter((suggestion) => suggestion.name === 'Josh');
    expect(joshes).toHaveLength(1);
  });

  it('ignores drafts and blank turns', async () => {
    const bus = new AmeliaBus();
    registerNameSuggestions(bus);
    const suggestions = collect(bus);

    for (let i = 0; i < 12; i += 1) {
      bus.emit({
        type: 'utterance',
        utterance_id: `d-${i}`,
        conversation_id: CONVERSATION,
        text: i % 2 === 0 ? '   ' : 'Also Josh, tomorrow',
        start_ms: i * 1000,
        end_ms: i * 1000 + 900,
        is_final: false,
      });
    }
    await settle();

    expect(suggestions).toHaveLength(0);
  });
});

describe('cost of scoring during a live conversation', () => {
  const utteranceEvent = (id: string, text: string, atMs: number): UtteranceEvent => ({
    type: 'utterance',
    utterance_id: id,
    conversation_id: CONVERSATION,
    text,
    start_ms: atMs,
    end_ms: atMs + 2_000,
    is_final: true,
  });

  it('never scores inside the bus dispatch', async () => {
    // Scoring walks the whole transcript. Doing it synchronously made every
    // drain block live audio behind all the turns that preceded it.
    const bus = new AmeliaBus();
    let clock = 1_000_000;
    registerNameSuggestions(bus, { now: () => clock });
    const suggestions = collect(bus);

    bus.emit(utteranceEvent('u1', "Hello, I'm Boris.", 0));
    bus.emit({
      type: 'speaker_pending',
      conversation_id: CONVERSATION,
      session_speaker: 'A',
      utterance_ids: ['u1'],
      speech_ms: 0,
      provisional_speech_ms: 8_000,
      reason: 'gathering',
    });
    expect(suggestions).toHaveLength(0);

    await settle();
    expect(suggestions.length).toBeGreaterThan(0);
  });

  it('always scores when the conversation ends, however recently it last ran', async () => {
    // The last thing said is the most likely to name somebody, so the end of a
    // conversation must not be gated by the drain interval.
    const bus = new AmeliaBus();
    const clock = 1_000_000;
    registerNameSuggestions(bus, { now: () => clock });
    const suggestions = collect(bus);

    bus.emit(utteranceEvent('u1', 'Yeah for sure.', 0));
    bus.emit(utteranceEvent('u2', "Hello, I'm Boris.", 3_000));
    bus.emit({
      type: 'speaker_pending',
      conversation_id: CONVERSATION,
      session_speaker: 'A',
      utterance_ids: ['u1', 'u2'],
      speech_ms: 0,
      provisional_speech_ms: 8_000,
      reason: 'gathering',
    });
    bus.emit({
      type: 'conversation',
      conversation_id: CONVERSATION,
      ended_at: new Date(0).toISOString(),
    });
    await settle();

    expect(suggestions.map((s) => s.name)).toContain('Boris');
  });
});
