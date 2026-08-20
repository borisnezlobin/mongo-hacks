import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Fact, Utterance } from '../../shared/contracts';

const mocks = vi.hoisted(() => ({
  extractStructured: vi.fn(),
  findFactBySourceClaim: vi.fn(),
  getPerson: vi.fn(),
  recordFact: vi.fn(),
  recordPromise: vi.fn(),
  resolveFactState: vi.fn(),
  utteranceFindOne: vi.fn(),
  utterances: [] as Utterance[],
}));

vi.mock('./llm', () => ({ extractStructured: mocks.extractStructured }));
vi.mock('./store', () => ({
  findFactBySourceClaim: mocks.findFactBySourceClaim,
  getPerson: mocks.getPerson,
  recordFact: mocks.recordFact,
  recordPromise: mocks.recordPromise,
  resolveFactState: mocks.resolveFactState,
}));
vi.mock('./db', () => ({
  collections: {
    utterances: () => ({
      find: () => ({ sort: () => ({ toArray: async () => mocks.utterances }) }),
      findOne: mocks.utteranceFindOne,
    }),
  },
}));

import { admissibleFacts, labelWindow, runSlowPass, runWindowPass } from './passes';

const bus = { emit: vi.fn(), subscribe: vi.fn() } as never;

let sequence = 0;

function utterance(text: string, personId?: string, overrides: Partial<Utterance> = {}): Utterance {
  sequence += 1;
  return {
    _id: overrides._id ?? `u-${sequence}`,
    owner_id: 'owner',
    conversation_id: 'c-live',
    // Settled by default so each test states the one thing it is about; the
    // suite below covers what happens when it is not.
    ...(personId ? { person_id: personId, identity_confidence: 'confirmed' as const } : {}),
    text,
    // Far enough apart that nothing coalesces unless a test wants it to.
    start_ms: sequence * 10_000,
    end_ms: sequence * 10_000 + 2_000,
    is_final: true,
    created_at: '2026-08-17T00:00:00Z',
    updated_at: '2026-08-17T00:00:00Z',
    ...overrides,
  };
}

const PEOPLE: Record<string, { name: string; is_unnamed?: boolean }> = {
  'p-maya': { name: 'Maya' },
  'p-jules': { name: 'Jules' },
  'p-voice': { name: 'Unknown voice 4c21', is_unnamed: true },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPerson.mockImplementation(async (id: string) => (PEOPLE[id] ? { _id: id, ...PEOPLE[id] } : null));
  mocks.findFactBySourceClaim.mockResolvedValue(null);
  mocks.resolveFactState.mockResolvedValue(null);
  mocks.utterances = [];
});

/** A window long enough to clear the "is there anything here at all" gate. */
function conversationWindow(): Utterance[] {
  return [
    utterance('So how did everybody end up in this building anyway', 'p-jules', { _id: 'u-open' }),
    utterance('I transferred in last year, I study applied mathematics', 'p-maya', { _id: 'u-maya-study' }),
    utterance('Yeah.', 'p-jules'),
    utterance('Actually my move date changed to September twentieth', 'p-maya', { _id: 'u-maya-move' }),
  ];
}

describe('window extraction', () => {
  it('runs one call for a window of many turns', async () => {
    mocks.extractStructured.mockResolvedValueOnce({ promises: [], facts: [] });

    await runWindowPass(bus, conversationWindow());

    expect(mocks.extractStructured).toHaveBeenCalledTimes(1);
  });

  it('does not call the model at all for a window of pure backchannel', async () => {
    const backchannel = ['Yeah.', 'Oh okay', 'Right.', 'Mhm.', 'Wait what?', 'Yeah, no.']
      .map((text) => utterance(text, 'p-maya'));

    await expect(runWindowPass(bus, backchannel)).resolves.toBe(false);
    expect(mocks.extractStructured).not.toHaveBeenCalled();
  });

  it('supersedes current state when the window carries a correction', async () => {
    const current: Fact = {
      _id: 'f-old',
      owner_id: 'owner',
      person_id: 'p-maya',
      attribute: 'move',
      claim: 'Maya moves on September 15.',
      claim_normalized: 'maya moves on september 15',
      primary_source_utterance_id: 'u-old',
      valid_from: '2026-08-12T00:00:00Z',
      created_at: '2026-08-12T00:00:00Z',
    };
    mocks.resolveFactState.mockResolvedValue(current);
    mocks.utteranceFindOne.mockImplementation(async ({ _id }: { _id: string }) => ({
      ...utterance('x', 'p-maya', { _id }),
      start_ms: _id === 'u-old' ? 0 : 500_000,
    }));
    mocks.extractStructured
      .mockResolvedValueOnce({
        promises: [],
        facts: [{
          person_id: 'p-maya',
          attribute: 'move_date',
          claim: 'Maya moves on September 20.',
          source_turn_id: 'u-maya-move',
          subject_is_speaker: true,
          evidence_quote: 'my move date changed to September twentieth',
        }],
      })
      .mockResolvedValueOnce({ relation: 'replace', reason: 'The move date changed.' });

    await runWindowPass(bus, conversationWindow());

    expect(mocks.recordFact).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      person_id: 'p-maya',
      // The legacy spelling the model may still emit is canonicalised on the way in.
      attribute: 'move',
      supersedes: 'f-old',
    }));
  });
});

describe('refusing to file against an unsettled identity', () => {
  async function admitFrom(window: Utterance[], fact: Record<string, unknown>) {
    const labelled = await labelWindow(window);
    return admissibleFacts({ promises: [], facts: [fact] } as never, labelled);
  }

  const CLAIM = {
    person_id: 'p-maya',
    attribute: 'study',
    claim: 'Maya studies applied mathematics.',
    source_turn_id: 'u-maya-study',
    subject_is_speaker: true,
    evidence_quote: 'I study applied mathematics',
  };

  it('refuses a fact about a provisionally identified speaker', async () => {
    const window = conversationWindow().map((item) => (
      item.person_id === 'p-maya' ? { ...item, identity_confidence: 'provisional' as const } : item
    ));

    expect(await admitFrom(window, CLAIM)).toEqual([]);
  });

  it('treats an utterance with no identity_confidence at all as unsettled', async () => {
    const window = conversationWindow().map(({ identity_confidence: _dropped, ...rest }) => rest);

    expect(await admitFrom(window, CLAIM)).toEqual([]);
  });

  it('refuses when only some of a speaker\'s turns in the window are settled', async () => {
    const window = [
      ...conversationWindow(),
      utterance('And I grew up two towns over from here', 'p-maya', { identity_confidence: 'pending' }),
    ];

    expect(await admitFrom(window, CLAIM)).toEqual([]);
  });

  it('files the fact once the identity is confirmed', async () => {
    expect(await admitFrom(conversationWindow(), CLAIM)).toHaveLength(1);
  });

  it('refuses a promise from a speaker who is only provisionally identified', async () => {
    mocks.extractStructured.mockResolvedValueOnce({
      facts: [],
      promises: [{
        speaker_person_id: 'p-maya',
        source_turn_id: 'u-maya-study',
        text: 'Maya will send the reading list',
        evidence_quote: 'I study applied mathematics',
      }],
    });
    const window = conversationWindow().map((item) => (
      item.person_id === 'p-maya' ? { ...item, identity_confidence: 'provisional' as const } : item
    ));

    await runWindowPass(bus, window);

    expect(mocks.recordPromise).not.toHaveBeenCalled();
  });
});

describe('two facts from one sentence', () => {
  it('keeps both preferences a single utterance states', async () => {
    const current: Fact = {
      _id: 'f-dark',
      owner_id: 'owner',
      person_id: 'p-maya',
      attribute: 'preference',
      claim: 'Maya does not like walking to school in the dark.',
      claim_normalized: 'maya does not like walking to school in the dark',
      primary_source_utterance_id: 'u-maya-study',
      valid_from: '2026-08-17T00:00:00Z',
      created_at: '2026-08-17T00:00:00Z',
    };
    mocks.resolveFactState.mockResolvedValue(current);
    mocks.extractStructured
      .mockResolvedValueOnce({
        promises: [],
        facts: [{
          person_id: 'p-maya',
          attribute: 'preference',
          claim: 'Maya does not want to join a sorority.',
          source_turn_id: 'u-maya-study',
          subject_is_speaker: true,
          evidence_quote: 'I study applied mathematics',
        }],
      })
      .mockResolvedValueOnce({ relation: 'coexist', reason: 'Two unrelated preferences.' });

    await runWindowPass(bus, conversationWindow());

    expect(mocks.recordFact).toHaveBeenCalledWith(expect.anything(), expect.not.objectContaining({
      supersedes: expect.anything(),
    }));
  });
});

describe('refusing to guess who a fact belongs to', () => {
  async function admit(fact: Record<string, unknown>, window = conversationWindow()) {
    const labelled = await labelWindow(window);
    return admissibleFacts({ promises: [], facts: [fact] } as never, labelled);
  }

  it('accepts a first-person claim from the speaker of the cited turn', async () => {
    const admitted = await admit({
      person_id: 'p-maya',
      attribute: 'study',
      claim: 'Maya studies applied mathematics.',
      source_turn_id: 'u-maya-study',
      subject_is_speaker: true,
      evidence_quote: 'I study applied mathematics',
    });

    expect(admitted).toHaveLength(1);
    expect(admitted[0]?.primary_source_utterance_id).toBe('u-maya-study');
  });

  it('rejects a first-person claim attributed to somebody who did not speak that turn', async () => {
    const admitted = await admit({
      person_id: 'p-jules',
      attribute: 'study',
      claim: 'Jules studies applied mathematics.',
      source_turn_id: 'u-maya-study',
      subject_is_speaker: true,
      evidence_quote: 'I study applied mathematics',
    });

    expect(admitted).toEqual([]);
  });

  it('rejects a third-person claim whose subject is never named in the window', async () => {
    const window = [
      utterance('So how did everybody end up in this building anyway', 'p-jules', { _id: 'u-open' }),
      utterance("He's a sophomore, he transferred in from somewhere else", 'p-jules', { _id: 'u-pronoun' }),
      utterance('Yeah.', 'p-maya'),
    ];

    const admitted = await admit({
      person_id: 'p-maya',
      attribute: 'academic_year',
      claim: 'Maya is a sophomore.',
      source_turn_id: 'u-pronoun',
      subject_is_speaker: false,
      evidence_quote: "He's a sophomore",
    }, window);

    expect(admitted).toEqual([]);
  });

  it('accepts a third-person claim when the subject is named out loud', async () => {
    const window = [
      utterance('So how did everybody end up in this building anyway', 'p-jules', { _id: 'u-open' }),
      utterance('Maya is a sophomore, she transferred in last year', 'p-jules', { _id: 'u-named' }),
      utterance('Yeah that is right.', 'p-maya'),
    ];

    const admitted = await admit({
      person_id: 'p-maya',
      attribute: 'academic_year',
      claim: 'Maya is a sophomore.',
      source_turn_id: 'u-named',
      subject_is_speaker: false,
      evidence_quote: 'Maya is a sophomore',
    }, window);

    expect(admitted).toHaveLength(1);
  });

  it('rejects a third-person claim about a voice that has no name yet', async () => {
    const window = [
      utterance('So how did everybody end up in this building anyway', 'p-jules', { _id: 'u-open' }),
      utterance('That guy over there is a sophomore studying engineering', 'p-jules', { _id: 'u-vague' }),
      utterance('Yeah.', 'p-voice'),
    ];

    const admitted = await admit({
      person_id: 'p-voice',
      attribute: 'academic_year',
      claim: 'He is a sophomore.',
      source_turn_id: 'u-vague',
      subject_is_speaker: false,
      evidence_quote: 'That guy over there is a sophomore',
    }, window);

    expect(admitted).toEqual([]);
  });

  it('rejects a claim about a person who never appears in the window', async () => {
    const admitted = await admit({
      person_id: 'p-invented',
      attribute: 'study',
      claim: 'Somebody studies applied mathematics.',
      source_turn_id: 'u-maya-study',
      subject_is_speaker: true,
      evidence_quote: 'I study applied mathematics',
    });

    expect(admitted).toEqual([]);
  });

  it('rejects a claim that never says who it is about', async () => {
    const admitted = await admit({
      person_id: 'p-maya',
      attribute: 'study',
      claim: 'studies applied mathematics',
      source_turn_id: 'u-maya-study',
      subject_is_speaker: true,
      evidence_quote: 'I study applied mathematics',
    });

    expect(admitted).toEqual([]);
  });

  it('rejects a claim whose evidence was never said', async () => {
    const admitted = await admit({
      person_id: 'p-maya',
      attribute: 'employer',
      claim: 'Maya works at a hedge fund in Connecticut.',
      source_turn_id: 'u-maya-study',
      subject_is_speaker: true,
      evidence_quote: 'I work at a hedge fund in Connecticut',
    });

    expect(admitted).toEqual([]);
  });

  it('rejects a citation of a turn outside the window', async () => {
    const admitted = await admit({
      person_id: 'p-maya',
      attribute: 'study',
      claim: 'Maya studies applied mathematics.',
      source_turn_id: 'u-somewhere-else',
      subject_is_speaker: true,
      evidence_quote: 'I study applied mathematics',
    });

    expect(admitted).toEqual([]);
  });

  it('never attaches a fact to unattributed speech', async () => {
    const window = [
      utterance('So how did everybody end up in this building anyway', 'p-jules', { _id: 'u-open' }),
      utterance('I am a sophomore studying industrial engineering', undefined, { _id: 'u-nobody' }),
    ];

    const admitted = await admit({
      person_id: 'p-maya',
      attribute: 'academic_year',
      claim: 'Maya is a sophomore.',
      source_turn_id: 'u-nobody',
      subject_is_speaker: true,
      evidence_quote: 'I am a sophomore',
    }, window);

    expect(admitted).toEqual([]);
  });
});

describe('promises', () => {
  it('drops a promise put in a different speaker\'s mouth', async () => {
    mocks.extractStructured.mockResolvedValueOnce({
      facts: [],
      promises: [{
        speaker_person_id: 'p-jules',
        source_turn_id: 'u-maya-study',
        text: 'Send the reading list',
        evidence_quote: 'I study applied mathematics',
      }],
    });

    await runWindowPass(bus, conversationWindow());

    expect(mocks.recordPromise).not.toHaveBeenCalled();
  });
});

describe('closing sweep', () => {
  it('re-reads a long conversation in a handful of wide windows, not once per turn', async () => {
    mocks.utterances = Array.from({ length: 400 }, (_, index) =>
      utterance(`Turn ${index}: something with a fair amount of genuine content in it for once.`, 'p-maya'));
    mocks.extractStructured.mockResolvedValue({ promises: [], facts: [] });

    await runSlowPass(bus, 'c-live');

    expect(mocks.extractStructured.mock.calls.length).toBeGreaterThan(0);
    expect(mocks.extractStructured.mock.calls.length).toBeLessThan(mocks.utterances.length / 20);
  });
});
