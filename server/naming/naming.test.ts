import { describe, expect, it, vi } from 'vitest';
import { NAME_SUGGESTION_MIN_CONFIDENCE } from '../../shared/contracts';
import { hasRealFixture, missingFixtureNotice, readRealFixture, readRealLines } from '../../fixtures/real-audio';

const DORM_FIXTURE = 'dorm-9pm.diarize.json';
// Read at runtime, not imported: a static import of a gitignored file fails the
// whole suite to compile on a fresh clone rather than skipping one describe.
const dorm = hasRealFixture(DORM_FIXTURE)
  ? readRealFixture<{ segments: Array<{ id?: string; speaker: string; start: number; end: number; text: string }> }>(DORM_FIXTURE)
  : { segments: [] };
import { NameSuggester, suggestNames, suggestNamesWithLlm } from './index';
import { ruleMentions } from './suggest';
import type { NamingTurn } from './types';

function dormTurns(): NamingTurn[] {
  return dorm.segments.map((segment, index) => ({
    id: segment.id ?? `seg_${index}`,
    speaker: segment.speaker,
    text: segment.text,
    start_ms: Math.round(segment.start * 1000),
    end_ms: Math.round(segment.end * 1000),
  }));
}

function turns(lines: Array<[string, string]>): NamingTurn[] {
  return lines.map(([speaker, text], index) => ({
    id: `u${index}`,
    speaker,
    text,
    start_ms: index * 4_000,
    end_ms: index * 4_000 + 3_000,
  }));
}

const WHISPER_FIXTURE = 'dorm-40min.whisper.json';
const PYANNOTE_FIXTURE = 'dorm-40min.pyannote.json';

/**
 * What the server itself builds: whisper's words, punctuation restored, snapped
 * onto pyannote's turns. `readRealLines` is the shared reader, and it is shared
 * on purpose — mapping the raw `words` array by hand, which this used to do,
 * yields whisper's bare timed stream, where the punctuation lives only on the
 * segment text and never reaches the words. That is the wrong input for naming
 * in particular: half the vocative rules key on punctuation, so testing without
 * it exercises rules that cannot fire and invents candidates that cannot exist.
 */
let joinedCache: NamingTurn[] | undefined;
function joinedTurns(): NamingTurn[] {
  // Memoised: 48 minutes of words joined onto turns is ~200 ms, and the
  // assertions below call this a dozen times over. The lines never change.
  joinedCache ??= readRealLines('dorm-40min');
  return joinedCache;
}

const NINE_PM_WHISPER = 'dorm-9pm.whisper.json';
const NINE_PM_PYANNOTE = 'dorm-9pm.pyannote.json';

/** The three-minute recording as the server builds it, not as the retired provider did. */
let ninePmCache: NamingTurn[] | undefined;
function ninePmJoinedTurns(): NamingTurn[] {
  ninePmCache ??= readRealLines('dorm-9pm');
  return ninePmCache;
}

const dormNotice = hasRealFixture(DORM_FIXTURE) ? '' : ` — ${missingFixtureNotice(DORM_FIXTURE)}`;
const ninePmNotice = hasRealFixture(NINE_PM_WHISPER) ? '' : ` — ${missingFixtureNotice(NINE_PM_WHISPER)}`;
const joinedNotice = hasRealFixture(WHISPER_FIXTURE) ? '' : ` — ${missingFixtureNotice(WHISPER_FIXTURE)}`;

/**
 * NOT THE PRODUCT'S BEHAVIOUR. `dorm-9pm.diarize.json` is the retired realtime
 * provider's output, with its own A–G labels and its own punctuation, and
 * nothing in the app produces a transcript of that shape any more. It is kept
 * because it is a clean, correctly segmented three minutes — a good bench for
 * the vocative rules in isolation, where one voice says the name and one voice
 * owns it.
 *
 * What the product actually does with this same recording is asserted below,
 * in "three minutes of dorm talk, joined the way the server joins it", and the
 * answer there is that it proposes nobody. Do not read `Josh->A` here as the
 * product naming Josh. It does not.
 */
describe.skipIf(!hasRealFixture(DORM_FIXTURE))(
  `the vocative rules on a cleanly segmented transcript${dormNotice}`,
  () => {
  const result = suggestNames({ conversation_id: 'dorm-9pm', turns: dormTurns() });
  const josh = result.suggestions.find((suggestion) => suggestion.name === 'Josh');

  it('proposes Josh for speaker A from the vocative at ~55 s', () => {
    expect(josh).toBeDefined();
    expect(josh?.session_speaker).toBe('A');
    expect(josh?.kind).toBe('vocative');
    expect(josh?.evidence).toContain('Josh');
    expect(josh?.evidence_utterance_id).toBe('seg_21');
    expect(josh?.confidence).toBeGreaterThanOrEqual(NAME_SUGGESTION_MIN_CONFIDENCE);
  });

  it('does not propose Josh for C, who said it', () => {
    const misattributed = result.suggestions.filter(
      (suggestion) => suggestion.name === 'Josh' && suggestion.session_speaker === 'C',
    );
    expect(misattributed).toEqual([]);
  });

  it('proposes nothing else from three minutes of dorm talk', () => {
    expect(result.suggestions.map((suggestion) => `${suggestion.name}->${suggestion.session_speaker}`)).toEqual([
      'Josh->A',
    ]);
  });

  it('never mistakes the apps and places in this transcript for people', () => {
    const notPeople = ['Luma', 'Google', 'Maps', 'Haas', 'Hotz', 'Cal', 'Transit', 'Stargaze', 'Union'];
    for (const word of notPeople) {
      expect(result.suggestions.map((suggestion) => suggestion.name)).not.toContain(word);
    }
  });

  it('keeps Josh out of the suggestions when A is already named Josh', () => {
    const known = suggestNames({
      conversation_id: 'dorm-9pm',
      turns: dormTurns(),
      named_speakers: { A: 'Josh' },
    });
    expect(known.suggestions).toEqual([]);
    expect(known.suppressed.some((entry) => entry.reason === 'voice_already_has_this_name')).toBe(true);
  });

  it('refuses to rename another voice to a name already in the room', () => {
    const known = suggestNames({
      conversation_id: 'dorm-9pm',
      turns: dormTurns(),
      known_participants: [{ person_id: 'p1', name: 'Josh', speaker: 'Z' }],
    });
    expect(known.suggestions).toEqual([]);
    expect(known.suppressed.some((entry) => entry.reason === 'name_belongs_to_known_participant')).toBe(true);
  });
  },
);

/**
 * The same three minutes through the real path: whisper's punctuated words
 * snapped onto pyannote's turns. The product proposes nobody here, and that is
 * the correct answer rather than a miss.
 *
 * pyannote splits Joshua across two labels — his own speech lands on one and
 * the vocative aimed at him targets the other — so there is no single voice for
 * the name to attach to. `eval:diarization` independently reports 4 speakers
 * for 3 people with Joshua's recall at 59.5%. The rules find the vocative and
 * read it correctly; the addressee guess is what hedges, because another voice
 * is genuinely as likely.
 *
 * The blocker is upstream in diarization. Nothing in this module should be
 * tuned to reach Josh, and no threshold lowered to let him through: the name
 * would land on a voice that is only partly him.
 */
describe.skipIf(!hasRealFixture(NINE_PM_WHISPER) || !hasRealFixture(NINE_PM_PYANNOTE))(
  `three minutes of dorm talk, joined the way the server joins it${ninePmNotice}`,
  () => {
    const result = suggestNames({ conversation_id: 'dorm-9pm', turns: ninePmJoinedTurns() });

    it('proposes nobody, because no voice here is wholly one person', () => {
      expect(result.suggestions).toEqual([]);
    });

    it('still finds the one real vocative, and explains why it held back', () => {
      const josh = result.suppressed.find((entry) => entry.name === 'Josh');
      expect(josh?.reason).toBe('below_threshold');
      expect(josh?.kind).toBe('vocative');
      expect(josh?.evidence).toContain('Josh');
      expect(josh?.confidence).toBeLessThan(NAME_SUGGESTION_MIN_CONFIDENCE);
    });

    it('invents no other candidates out of three minutes of speech', () => {
      // Unpunctuated, this recording produced three mentions and the strongest
      // was "Infectious" read as a person. Punctuation is what tells a proper
      // noun from a capitalised word, so the real path sees exactly one.
      expect(ruleMentions({ conversation_id: 'dorm-9pm', turns: ninePmJoinedTurns() })).toHaveLength(1);
    });
  },
);

describe('attribution', () => {
  it('names the speaker from a self-introduction, lowercase and disfluent', () => {
    const result = suggestNames({
      conversation_id: 'c',
      turns: turns([
        ['s1', 'hey what\'s up'],
        ['s2', "uh yeah i'm tarun, i just moved in upstairs"],
      ]),
    });
    const tarun = result.suggestions.find((suggestion) => suggestion.name === 'Tarun');
    expect(tarun?.session_speaker).toBe('s2');
    expect(tarun?.kind).toBe('self_introduction');
  });

  it('names the addressee, not the speaker, from a vocative', () => {
    const result = suggestNames({
      conversation_id: 'c',
      turns: turns([
        ['s2', 'so we were saying'],
        ['s1', 'hey Josh, you good?'],
        ['s2', 'yeah I am fine'],
      ]),
    });
    const josh = result.suggestions.find((suggestion) => suggestion.name === 'Josh');
    expect(josh?.session_speaker).toBe('s2');
  });

  it('holds back when the addressee is genuinely ambiguous', () => {
    const result = suggestNames({
      conversation_id: 'c',
      turns: turns([
        ['s2', 'anyway'],
        ['s1', 'thanks Josh'],
        ['s3', 'no worries'],
      ]),
    });
    expect(result.suggestions).toEqual([]);
    expect(result.suppressed.some((entry) => entry.name === 'Josh' && entry.reason === 'below_threshold')).toBe(true);
  });

  it('needs corroboration when one address is not conclusive on its own', () => {
    const spaced: NamingTurn[] = [
      { id: 'a', speaker: 's2', text: 'ok', start_ms: 0, end_ms: 3_000 },
      { id: 'b', speaker: 's1', text: 'hey Josh, you coming', start_ms: 60_000, end_ms: 63_000 },
      { id: 'c', speaker: 's2', text: 'yeah', start_ms: 63_500, end_ms: 65_000 },
      { id: 'd', speaker: 's1', text: 'hey Josh, what time', start_ms: 130_000, end_ms: 133_000 },
      { id: 'e', speaker: 's2', text: 'nine', start_ms: 133_500, end_ms: 135_000 },
    ];

    const once = suggestNames({ conversation_id: 'c', turns: spaced.slice(0, 3) });
    expect(once.suggestions).toEqual([]);

    const twice = suggestNames({ conversation_id: 'c', turns: spaced });
    expect(twice.suggestions.map((suggestion) => suggestion.session_speaker)).toEqual(['s2']);
  });

  it('names nobody present from a third-person reference', () => {
    const result = suggestNames({
      conversation_id: 'c',
      turns: turns([
        ['s1', 'Tarun said he would be late'],
        ['s2', 'okay'],
      ]),
    });
    expect(result.suggestions).toEqual([]);
    const tarun = result.suppressed.find((entry) => entry.name === 'Tarun');
    expect(tarun?.kind).toBe('third_person_reference');
    expect(tarun?.reason).toBe('no_addressee');
  });

  it('collapses a name claimed by two different voices', () => {
    const result = suggestNames({
      conversation_id: 'c',
      turns: turns([
        ['s3', 'right'],
        ['s1', 'hey Josh, you good?'],
        ['s2', 'yeah'],
        ['s3', 'sure'],
        ['s2', 'hey Josh, over here'],
        ['s3', 'yep'],
      ]),
    });
    expect(result.suggestions.filter((suggestion) => suggestion.name === 'Josh')).toEqual([]);
  });

  it('never proposes a name for the owner\'s own voice, or the owner\'s name', () => {
    const result = suggestNames({
      conversation_id: 'c',
      turns: turns([
        ['owner', 'blah'],
        ['s1', 'hey Boris, you good?'],
        ['owner', 'yeah I am'],
      ]),
      owner_name: 'Boris',
      owner_speaker: 'owner',
    });
    expect(result.suggestions).toEqual([]);
    expect(result.suppressed.some((entry) => entry.reason === 'owner_name')).toBe(true);
  });

  it('merges an ASR misspelling into the name it keeps hearing', () => {
    const result = suggestNames({
      conversation_id: 'c',
      turns: turns([
        ['s2', 'ok'],
        ['s1', 'hey Tarun, you coming'],
        ['s2', 'yeah'],
        ['s1', 'sorry Taruun, one more thing'],
        ['s2', 'go ahead'],
      ]),
    });
    expect(result.suggestions.map((suggestion) => suggestion.name)).toEqual(['Tarun']);
  });
});

describe('precision on tricky speech', () => {
  const notNames: Array<[string, string]> = [
    ['a contraction that looks like a self-introduction', "Hey, I'm gonna go"],
    ['an app', 'let me download Luma'],
    ['a product with two words', "I'll do Google Maps for the first day"],
    ['a building', "you're gonna end up at the top of Haas"],
    ['an event', 'oh I did that on Cal Day'],
    ['an app after a determiner', 'you can get the transit app, the Transit app is free'],
    ['filler at a turn boundary', 'Okay, thank you. Alright, one second guys.'],
    ['a hedge', 'Dude, I was gonna say the smartest thing ever'],
    ['profanity', "No it's like, bro it's like some bullshit, fucking hell"],
    ['a false start', 'I was, uh, I was, no wait, never mind'],
  ];

  for (const [label, text] of notNames) {
    it(`proposes nobody for ${label}`, () => {
      const result = suggestNames({
        conversation_id: 'c',
        turns: turns([
          ['s1', text],
          ['s2', 'yeah'],
          ['s1', text],
          ['s2', 'sure'],
        ]),
      });
      expect(result.suggestions).toEqual([]);
    });
  }

  it('still finds the real name buried in the same kind of speech', () => {
    const result = suggestNames({
      conversation_id: 'c',
      turns: turns([
        ['s1', "uh yeah I'm gonna go download Luma, the transit app is free too"],
        ['s2', "wait, what's your name again"],
        ['s1', "oh my name's tarun, sorry"],
      ]),
    });
    expect(result.suggestions.map((suggestion) => suggestion.name)).toEqual(['Tarun']);
    expect(result.suggestions[0]?.session_speaker).toBe('s1');
  });
});

describe('the streaming accumulator', () => {
  it('emits a suggestion once and then only when it strengthens', () => {
    const suggester = new NameSuggester({ conversation_id: 'c' });
    const conversation = turns([
      ['s2', 'ok'],
      ['s1', 'hey Tarun, you coming'],
      ['s2', 'yeah'],
      ['s1', 'sorry Tarun, what time'],
      ['s2', 'nine'],
    ]);

    suggester.ingest(conversation.slice(0, 3));
    const first = suggester.drain();
    expect(first.map((event) => event.name)).toEqual(['Tarun']);

    suggester.ingest(conversation.slice(0, 3));
    expect(suggester.drain()).toEqual([]);

    suggester.ingest(conversation.slice(3));
    const strengthened = suggester.drain();
    expect(strengthened).toHaveLength(1);
    expect(strengthened[0]!.confidence).toBeGreaterThan(first[0]!.confidence);
  });

  it('replaces a revised turn rather than counting it twice', () => {
    const suggester = new NameSuggester({ conversation_id: 'c' });
    suggester.ingest({ id: 'u1', speaker: 's1', text: 'hey Tar', start_ms: 0, end_ms: 1_000 });
    suggester.ingest({ id: 'u1', speaker: 's1', text: 'hey Tarun, you coming', start_ms: 0, end_ms: 1_000 });
    suggester.ingest({ id: 'u2', speaker: 's2', text: 'yeah', start_ms: 1_200, end_ms: 2_000 });
    const mentions = suggester.current().mentions.filter((mention) => mention.name === 'Tarun');
    expect(mentions).toHaveLength(1);
  });
});

describe('the optional LLM pass', () => {
  const conversation = turns([
    ['s1', 'so anyway'],
    ['s2', 'the guy behind you there'],
    ['s1', 'yeah him'],
  ]);

  it('degrades to rules only when the model throws', async () => {
    const llm = vi.fn().mockRejectedValue(new Error('no api key'));
    const result = await suggestNamesWithLlm({ conversation_id: 'c', turns: conversation }, llm);
    expect(result.suggestions).toEqual([]);
    expect(llm).toHaveBeenCalled();
  });

  it('is identical to the rule pass when no model is injected', async () => {
    const withoutLlm = await suggestNamesWithLlm({ conversation_id: 'c', turns: dormTurns() });
    expect(withoutLlm.suggestions).toEqual(suggestNames({ conversation_id: 'c', turns: dormTurns() }).suggestions);
  });

  it('accepts a model mention whose quote is really in the transcript', async () => {
    const llm = vi.fn().mockResolvedValue({
      mentions: [
        {
          name: 'Marcus',
          kind: 'self_introduction',
          turn_id: 'u1',
          evidence: 'the guy behind you there is marcus',
        },
      ],
    });
    const spoken = turns([
      ['s1', 'so anyway'],
      ['s2', 'the guy behind you there is marcus, I think'],
    ]);
    const result = await suggestNamesWithLlm({ conversation_id: 'c', turns: spoken }, llm);
    expect(result.mentions.some((mention) => mention.name === 'Marcus' && mention.source === 'llm')).toBe(true);
  });

  it('throws away a hallucinated quote', async () => {
    const llm = vi.fn().mockResolvedValue({
      mentions: [
        { name: 'Marcus', kind: 'self_introduction', turn_id: 'u1', evidence: "hi everyone I'm Marcus" },
      ],
    });
    const result = await suggestNamesWithLlm({ conversation_id: 'c', turns: conversation }, llm);
    expect(result.mentions).toEqual([]);
    expect(result.suggestions).toEqual([]);
  });

  it('refuses a vocative the model attributes to its own speaker', async () => {
    const llm = vi.fn().mockResolvedValue({
      mentions: [
        { name: 'Josh', kind: 'vocative', turn_id: 'u1', target_speaker: 's2', evidence: 'the guy behind you there' },
      ],
    });
    const result = await suggestNamesWithLlm({ conversation_id: 'c', turns: conversation }, llm);
    expect(result.mentions).toEqual([]);
  });
});

describe('meeting somebody for the first time', () => {
  it('takes a self-introduction as near-decisive, and being asked as agreement', () => {
    const result = suggestNames({
      conversation_id: 'c',
      turns: turns([
        ['s1', 'yo guys, what up?'],
        ['s2', 'You Boris?'],
        ['s1', "Hello, I'm Boris."],
        ['s2', 'Nice to meet you. Where you from?'],
      ]),
    });
    const boris = result.suggestions.find((suggestion) => suggestion.name === 'Boris');
    expect(boris?.session_speaker).toBe('s1');
    expect(boris?.kind).toBe('self_introduction');
    expect(boris?.confidence).toBeGreaterThan(0.8);
    expect(result.suggestions.filter((suggestion) => suggestion.session_speaker === 's2')).toEqual([]);
  });

  it('reads the answer to "what\'s your name?" as the answerer\'s own name', () => {
    const result = suggestNames({
      conversation_id: 'c',
      turns: turns([
        ['s1', 'sure man, what up, what\'s the name?'],
        ['s2', 'Dhruv.'],
        ['s1', 'nice to meet you.'],
      ]),
    });
    const dhruv = result.suggestions.find((suggestion) => suggestion.name === 'Dhruv');
    expect(dhruv?.session_speaker).toBe('s2');
    expect(dhruv?.kind).toBe('self_introduction');
    expect(dhruv?.confidence).toBeGreaterThanOrEqual(NAME_SUGGESTION_MIN_CONFIDENCE);
  });

  it('works for a name no lexicon has ever heard of', () => {
    const result = suggestNames({
      conversation_id: 'c',
      turns: turns([
        ['s1', 'what is your name?'],
        ['s2', "sh I'm Nkechi."],
      ]),
    });
    expect(result.suggestions.map((suggestion) => [suggestion.name, suggestion.session_speaker])).toEqual([
      ['Nkechi', 's2'],
    ]);
  });

  it('introduces the late arrival too, not just the people who opened the conversation', () => {
    const filler: Array<[string, string]> = Array.from({ length: 40 }, (_, index) => [
      index % 2 === 0 ? 's1' : 's3',
      'yeah I mean the thing about that is it depends',
    ]);
    const result = suggestNames({
      conversation_id: 'c',
      turns: turns([...filler, ['s1', 'oh hey, what\'s your name?'], ['s4', 'Dhruv.'], ['s1', 'nice to meet you']]),
    });
    expect(result.suggestions.map((suggestion) => suggestion.session_speaker)).toEqual(['s4']);
  });

  it('gives one question one answer, and does not name the next thing anybody says', () => {
    const result = suggestNames({
      conversation_id: 'c',
      turns: turns([
        ['s1', 'what is your name?'],
        ['s2', 'Vova.'],
        ['s3', 'Maths.'],
        ['s1', 'oh nice'],
      ]),
    });
    expect(result.suggestions.map((suggestion) => suggestion.name)).toEqual(['Vova']);
    expect(result.suggestions[0]?.session_speaker).toBe('s2');
  });

  it('does not hand the name to whoever repeats it back while it is being asked about', () => {
    const result = suggestNames({
      conversation_id: 'c',
      turns: turns([
        ['s1', "hello, I'm Boris."],
        ['s2', 'what is your name? Boris.'],
        ['s3', 'uh Boris.'],
        ['s1', 'yeah'],
      ]),
    });
    const boris = result.suggestions.filter((suggestion) => suggestion.name === 'Boris');
    expect(boris.map((suggestion) => suggestion.session_speaker)).toEqual(['s1']);
  });

  it('proposes nobody when the answer to the question is not a name', () => {
    const result = suggestNames({
      conversation_id: 'c',
      turns: turns([
        ['s1', 'what is your name?'],
        ['s2', 'sorry, what did you say?'],
        ['s1', 'never mind'],
      ]),
    });
    expect(result.suggestions).toEqual([]);
  });

  it('does not hear a nationality as a name, even after "I\'m"', () => {
    const result = suggestNames({
      conversation_id: 'c',
      turns: turns([
        ['s1', "hello, I'm Boris."],
        ['s2', "oh shit, I'm Ukrainian, nice to meet you."],
        ['s1', 'what is your name?'],
        ['s2', "sh I'm Vova."],
      ]),
    });
    expect(result.suggestions.map((suggestion) => suggestion.name).sort()).toEqual(['Boris', 'Vova']);
  });

  it('reads "this is X" as introducing somebody else, not the speaker', () => {
    const result = suggestNames({
      conversation_id: 'c',
      turns: turns([
        ['s1', 'oh and this is Marcus'],
        ['s2', 'hey, good to meet you'],
        ['s1', 'he lives upstairs'],
      ]),
    });
    const marcus = result.suggestions.find((suggestion) => suggestion.name === 'Marcus');
    expect(marcus?.session_speaker).not.toBe('s1');
  });
});

/**
 * These inputs are written `A_N_J_A_`, the retired realtime provider's
 * rendering. Whisper writes `M A R T` instead, and the rule used to gate on
 * those separators, which meant it could not fire on anything the product
 * produced. It now gates on the capitalisation whisper gives dictated letters,
 * so both renderings reach the same code and this suite is no longer testing a
 * path of its own — it is the readable bench for reconstruction and for
 * acronym rejection. What the real recordings do with the same rule is
 * asserted in "spelling on the real recordings" below.
 */
describe('names that are spelled out', () => {
  it('reconstructs a spelled name as a candidate when the exchange is about a name', () => {
    const result = suggestNames({
      conversation_id: 'c',
      turns: turns([
        ['s1', 'sorry, what is your name again?'],
        ['s2', 'A_N_J_A_'],
        ['s1', 'oh got it'],
      ]),
    });
    expect(result.mentions.some((mention) => mention.name === 'Anja' && mention.target === 's2')).toBe(true);
  });

  it('does not read course codes and acronyms as names', () => {
    const result = suggestNames({
      conversation_id: 'c',
      turns: turns([
        ['s1', 'I am doing E_C_E_ and A_P_C_S_P_ this term'],
        ['s2', 'that is a lot'],
      ]),
    });
    expect(result.mentions).toEqual([]);
  });

  it('will not propose a spelled name on its own, because the letters come through badly', () => {
    const result = suggestNames({
      conversation_id: 'c',
      turns: turns([
        ['s1', 'sorry, your name again?'],
        ['s2', 'M_A_R_T_'],
        ['s1', 'okay'],
      ]),
    });
    expect(result.suggestions).toEqual([]);
  });
});

/**
 * Spelling is the only mechanism in the system that could recover a name the
 * transcriber gets wrong, so it is worth knowing exactly what it does with the
 * real recordings: it proposes nobody, and every rejection is for a stated
 * reason rather than by accident.
 *
 * The 48-minute recording spells letters aloud nine times. Two are the clock
 * ("8 a m", "11 p m") and are lower case. Two are two letters long ("U S",
 * "A Z"). "M A R T M A R T" is Mert spelling his name and the owner repeating
 * it back, glued into one turn. "R T" and "E R T" are further fragments of
 * that same exchange, arriving minutes apart on different voices. "A B C S P"
 * and "V E S T A" are not near talk about anybody's name.
 *
 * And "V O L V A" at 2735 s is the one that matters most, because it looks
 * like the prize and is not. It answers "how do you spell that?" — but the
 * question before it is "what was the Ukrainian guy's name?", asked about a man
 * who last spoke at 2355 s and had left. So the letters are one person's
 * account of an absent man's name, and taking them as a self-introduction
 * would put that absent man's name on the voice describing him. That is why
 * the rule reads them as third-person talk, and it is the whole point of this
 * suite.
 *
 * What this does NOT settle is which spelling is right. The owner has said
 * twice that the man's name is Volva, and he was in the room; the speaker here
 * also reaches for "Volva" before hedging to "Vladimir". A reading that the
 * transcriber's "Vova" is correct because it is the usual diminutive of
 * Vladimir was proposed here and is only an inference — it is contradicted by
 * the two people who actually know, so it is not recorded as fact. The rule's
 * behaviour is right either way: the frame is wrong regardless of the spelling,
 * because the man is not in the room to be named.
 */
describe.skipIf(!hasRealFixture(WHISPER_FIXTURE))(`spelling on the real recordings${joinedNotice}`, () => {
  const mentionsFor = (turns: NamingTurn[]) => ruleMentions({ conversation_id: 'c', turns });

  it('claims no voice from spelled letters in either recording', () => {
    for (const turns of [joinedTurns(), ninePmJoinedTurns()]) {
      expect(mentionsFor(turns).filter((mention) => mention.frame === 'spelled')).toEqual([]);
    }
  });

  it('reads the spelling of an absent man as talk about him, not as the speller\'s name', () => {
    const volva = mentionsFor(joinedTurns()).filter((mention) => mention.name === 'Volva');
    expect(volva).toHaveLength(1);
    expect(volva[0]?.frame).toBe('third_person');
    expect(volva[0]?.target).toBeUndefined();
  });

  it('proposes nobody from any of it, and says so rather than dropping it', () => {
    const result = suggestNames({ conversation_id: 'c', turns: joinedTurns() });
    expect(result.suggestions.some((suggestion) => suggestion.name === 'Volva')).toBe(false);
    expect(result.suppressed.some((entry) => entry.name === 'Volva')).toBe(true);
  });

  it('keeps the name from the self-introduction over the one spelled about him', () => {
    const proposed = suggestNames({ conversation_id: 'c', turns: joinedTurns() }).suggestions;
    expect(proposed.find((suggestion) => suggestion.name === 'Vova')?.session_speaker).toBe('SPEAKER_02');
  });

  it('invents nothing from the clock, from acronyms or from broken-up runs', () => {
    const names = new Set(mentionsFor(joinedTurns()).map((mention) => mention.name));
    for (const junk of ['Am', 'Pm', 'Martmart', 'Rti', 'Ert', 'Abcs', 'Vesta', 'Us', 'Az']) {
      expect(names.has(junk)).toBe(false);
    }
  });
});

/**
 * The guards that make the above true, on inputs small enough to read. Each
 * one is a general property of how people spell aloud, not a fact about these
 * recordings.
 */
describe('what is not a name being spelled', () => {
  const spelling = (lines: Array<[string, string]>) =>
    ruleMentions({ conversation_id: 'c', turns: turns(lines) });

  it('ignores the letters inside ordinary speech, which arrive in lower case', () => {
    // Digits are not letter tokens, so they do not interrupt a run: a glued
    // "8 a m 11 p m" is four consecutive letters and would otherwise be read
    // as somebody called Ampm. Whisper writes dictated letters in capitals and
    // these in lower case, and that is the whole of the difference.
    expect(spelling([
      ['s1', 'sorry, what is your name again?'],
      ['s2', 'what time? 8 a m 11 p m'],
    ])).toEqual([]);
  });

  it('declines a run that is the same letters twice, because that is an echo', () => {
    // "M A R T M A R T" is one person spelling and another repeating it back.
    // Reducing it to one copy would be guessing which half was the correction.
    expect(spelling([
      ['s1', 'sorry, what is your name again?'],
      ['s2', 'M A R T M A R T'],
    ])).toEqual([]);
  });

  it('declines the same letters coming back on another voice, which is a repeat-back', () => {
    // The in-turn doubling guard only catches this while the join glues the
    // speller and the checker together. A join that separates them correctly
    // hands the identical run to two voices seconds apart, and it is the same
    // echo — on the 48-minute recording, "M A R T" on two labels 2.6 s apart.
    const spelled = spelling([
      ['s1', 'sorry, what is your name again?'],
      ['s2', 'M A R T'],
      ['s3', 'M A R T'],
    ]);
    expect(spelled.filter((mention) => mention.frame === 'spelled')).toEqual([]);
  });

  it('declines a run too short to be a name somebody needed spelled', () => {
    expect(spelling([
      ['s1', 'sorry, what is your name again?'],
      ['s2', 'E R T'],
    ])).toEqual([]);
  });

  it('takes a clean spelling from the person who was asked, as their own', () => {
    const anja = spelling([
      ['s1', 'sorry, what is your name again?'],
      ['s2', 'A N J A'],
    ]);
    expect(anja).toHaveLength(1);
    expect(anja[0]?.frame).toBe('spelled');
    expect(anja[0]?.name).toBe('Anja');
  });

  it('does not take a spelling from somebody naming a third party', () => {
    // The speller is answering about somebody else. Whoever that is has to
    // come from evidence other than the letters.
    const spelled = spelling([
      ['s1', 'what was that guy\'s name, how do you spell it?'],
      ['s2', 'A N J A, I think. She left already.'],
    ]);
    expect(spelled.filter((mention) => mention.frame === 'spelled')).toEqual([]);
  });
});

/**
 * A join that draws its line boundaries differently must not change how much
 * the module believes. These are the two places it did.
 *
 * The sentence pass in `server/audio` went from 767 lines to 1,032 on the
 * 48-minute recording — more lines, shorter, each on one voice. Boris fell from
 * 0.90 to 0.52 on identical speech, and neither cause was the one it looked
 * like: his own evidence barely moved (0.898 to 0.872).
 */
describe('confidence that does not depend on where lines were drawn', () => {
  const room = (lines: Array<[string, string]>) =>
    suggestNames({ conversation_id: 'c', turns: turns(lines) });
  const confidenceOf = (result: ReturnType<typeof room>, name: string) =>
    result.suggestions.find((suggestion) => suggestion.name === name)?.confidence ?? 0;

  it('gives one question one answer, even when the answer is inside the question\'s turn', () => {
    // The real regression. Diarization glued "What's your name? ... I'm Vova."
    // into one turn, so the question was already answered; the forward scan ran
    // anyway and took a name from three turns later, landing a second
    // first-person claim on a different voice. The two then argued and the
    // real name lost 40% of its confidence.
    const mentions = ruleMentions({
      conversation_id: 'c',
      turns: turns([
        ['s2', "What's your name? I'm from Russia. I'm Nadia."],
        ['s4', 'Okay, that makes sense to me.'],
        ['s5', 'Nice to meet you.'],
        ['s4', 'Yeah, Marcus. Marcus.'],
      ]),
    });
    const answers = mentions.filter((mention) => mention.frame === 'name_answer');
    expect(answers.map((mention) => mention.name)).toEqual(['Nadia']);
    expect(mentions.some((mention) => mention.name === 'Marcus' && mention.target === 's4')).toBe(false);
  });

  it('still hears the answer when the question turn does not contain one', () => {
    // The forward scan has to keep working; it is what finds a reply that
    // landed in its own line.
    const mentions = ruleMentions({
      conversation_id: 'c',
      turns: turns([['s1', "What's your name?"], ['s2', 'Marcus.']]),
    });
    expect(mentions.filter((mention) => mention.frame === 'name_answer').map((m) => [m.name, m.target])).toEqual([
      ['Marcus', 's2'],
    ]);
  });

  it('never scores a name repeated below the same name said once', () => {
    // Repeating the answer is answering more insistently. It used to drop the
    // turn out of the "nothing but the name" reading and into a weaker one,
    // so saying it twice was worth less than saying it once.
    const once = confidenceOf(room([['s1', 'What is your name?'], ['s2', 'Boris.']]), 'Boris');
    for (const reply of ['Boris. Boris.', 'Boris. Boris. Boris.', 'uh, Boris. Boris.']) {
      expect(confidenceOf(room([['s1', 'What is your name?'], ['s2', reply]]), 'Boris')).toBeGreaterThanOrEqual(once);
    }
  });

  it('does not weaken a self-introduction when its line is split in two', () => {
    const glued = confidenceOf(room([['s1', 'hey'], ['s2', "I'm Marcus. Nice to meet you."]]), 'Marcus');
    const split = confidenceOf(
      room([['s1', 'hey'], ['s2', "I'm Marcus."], ['s2', 'Nice to meet you.']]),
      'Marcus',
    );
    expect(split).toBeGreaterThanOrEqual(glued);
  });
});

describe('names that are also clubs and companies', () => {
  it('will not propose a football club being talked about as a person', () => {
    const result = suggestNames({
      conversation_id: 'c',
      turns: turns([
        ['s1', 'put Hong Kong in there, oh it is'],
        ['s2', 'Chelsea. Wait wait, so you are'],
        ['s1', 'oh I am a fan bro'],
      ]),
    });
    expect(result.suggestions).toEqual([]);
  });

  it('still names a person addressed in a conversation that has nothing to do with football', () => {
    const result = suggestNames({
      conversation_id: 'c',
      turns: turns([
        ['s1', 'anyway'],
        ['s2', 'hey Chelsea, you good?'],
        ['s1', 'yeah I am fine'],
      ]),
    });
    expect(result.suggestions.map((suggestion) => suggestion.name)).toEqual(['Chelsea']);
  });
});

/**
 * Two people introducing themselves half an hour apart is ordinary, and the
 * two exchanges are evidence about two different voices. A 48-minute recording
 * used to end with one name out of three because a false claim raised late in
 * the conversation cancelled a true one made at the start.
 */
describe('a second introduction much later in the conversation', () => {
  const spread = (lines: Array<[number, string, string]>) =>
    suggestNames({
      conversation_id: 'c',
      turns: lines.map(([minute, speaker, text], index) => ({
        id: `u${index}`,
        speaker,
        text,
        start_ms: minute * 60_000,
        end_ms: minute * 60_000 + 3_000,
      })),
    });

  it('leaves the first introduction exactly as strong as it was alone', () => {
    const early: Array<[number, string, string]> = [
      [0.3, 's1', "hello, I'm Boris"],
      [0.4, 's2', "oh shit, I'm Ukrainian, nice to meet you. what's your name? I'm Vova"],
    ];
    const alone = spread(early);
    const withLateArrival = spread([
      ...early,
      [38.5, 's3', "lazy, what's your name?"],
      [38.6, 's4', 'Drew. what do you study? applied math.'],
    ]);
    const confidence = (result: ReturnType<typeof spread>, name: string) =>
      result.suggestions.find((suggestion) => suggestion.name === name)?.confidence;

    expect(confidence(alone, 'Vova')).toBeGreaterThanOrEqual(NAME_SUGGESTION_MIN_CONFIDENCE);
    expect(confidence(withLateArrival, 'Vova')).toBe(confidence(alone, 'Vova'));
    expect(confidence(withLateArrival, 'Boris')).toBe(confidence(alone, 'Boris'));
  });

  it('hears the late arrival too, on their own voice', () => {
    const result = spread([
      [0.4, 's2', "what's your name? I'm Vova"],
      [38.5, 's3', "lazy, what's your name?"],
      [38.6, 's4', 'Drew. what do you study? applied math.'],
    ]);
    const byName = new Map(result.suggestions.map((suggestion) => [suggestion.name, suggestion.session_speaker]));
    expect(byName.get('Vova')).toBe('s2');
    expect(byName.get('Drew')).toBe('s4');
  });
});

/**
 * The frames that carry the most weight are the ones an inflected verb slips
 * through, because "I'm" in front of a capitalised word the lexicon has never
 * seen is otherwise the strongest evidence there is. A false name lands on a
 * voice that already has a true one, and then the two cancel.
 */
describe('verbs that arrive dressed as names', () => {
  const said = (lines: Array<[string, string]>) =>
    suggestNames({
      conversation_id: 'c',
      turns: lines.map(([speaker, text], index) => ({
        id: `u${index}`,
        speaker,
        text,
        start_ms: index * 4_000,
        end_ms: index * 4_000 + 3_000,
      })),
    });

  it('does not read "I am Wizarding my freshman kids" as an introduction', () => {
    expect(said([
      ['s1', 'what have you been up to'],
      ['s2', 'I am Wizarding my freshman kids'],
    ]).suggestions).toEqual([]);
  });

  it('does not let one cancel a real name on the same voice', () => {
    const byName = new Map(
      said([
        ['s1', "what's your name?"],
        ['s2', "I'm Vova"],
        ['s1', 'what have you been up to'],
        ['s2', 'I am Wizarding my freshman kids'],
      ]).suggestions.map((suggestion) => [suggestion.name, suggestion.session_speaker]),
    );
    expect(byName.get('Vova')).toBe('s2');
    expect([...byName.keys()]).toEqual(['Vova']);
  });

  it('still keeps short names that merely end in those letters', () => {
    const byName = said([
      ['s1', "what's your name?"],
      ['s2', "I'm Ming"],
    ]).suggestions.map((suggestion) => suggestion.name);
    expect(byName).toContain('Ming');
  });
});

/**
 * Diarization does not stop a turn where the answer stops. A one-word reply
 * routinely arrives glued to whatever was said next, and the name was being
 * dropped because the turn around it was no longer answer-shaped.
 */
describe('an answer diarization ran on past', () => {
  const exchange = (reply: string) =>
    suggestNames({
      conversation_id: 'c',
      turns: [
        { id: 'u0', speaker: 's1', text: "what's your name", start_ms: 0, end_ms: 2_000 },
        { id: 'u1', speaker: 's2', text: reply, start_ms: 3_000, end_ms: 9_000 },
      ],
    });

  it('takes the name at the front of a turn that runs on into the next thing', () => {
    const drew = exchange('Drew What do you study Applied math It was').suggestions.find(
      (suggestion) => suggestion.name === 'Drew',
    );
    expect(drew?.session_speaker).toBe('s2');
    expect(drew?.kind).toBe('self_introduction');
  });

  it('proposes nothing else out of the words the turn ran on into', () => {
    expect(
      exchange('Drew What do you study Applied math It was').suggestions.map((suggestion) => suggestion.name),
    ).toEqual(['Drew']);
  });

  it('will not take a capitalised word it has never seen from mid-reply', () => {
    // Only the front of the reply is the answer's position, and only a word
    // that looks like a name survives without the shape of a bare answer.
    expect(exchange('So we were Larping in the Wizarding lounge').suggestions).toEqual([]);
  });
});

/**
 * Forty-eight minutes, seven people, taken the way the server actually takes
 * them: whisper's word timings joined onto pyannote's turns, through the same
 * `joinTranscriptToTurns` that `server/audio/session.ts` calls.
 *
 * This replaced a suite over `dorm-40min.merged.json`, the retired realtime
 * provider's output. That transcript was cut into 2,772 short, cleanly
 * segmented fragments; this join produces 767 longer lines, and the difference
 * is not cosmetic. The old suite asserted four names — Boris, Vova, Joshua and
 * a "Claire" the recording does not contain — and the product now proposes
 * two. It had been green for weeks against a transcript nothing produces.
 */
describe.skipIf(!hasRealFixture(WHISPER_FIXTURE) || !hasRealFixture(PYANNOTE_FIXTURE))(
  `forty-eight minutes joined from words and turns${joinedNotice}`,
  () => {
    const upTo = (minutes: number) =>
      suggestNames({
        conversation_id: 'dorm-40min',
        turns: joinedTurns().filter((turn) => turn.start_ms <= minutes * 60_000),
      });
    const named = (minutes: number) =>
      new Map(upTo(minutes).suggestions.map((suggestion) => [suggestion.name, suggestion.session_speaker]));

    it('hears the two people whose introductions land on their own voice', () => {
      expect([...named(48)].sort()).toEqual([
        ['Boris', 'SPEAKER_04'],
        ['Vova', 'SPEAKER_02'],
      ]);
    });

    it('finds the late introduction but declines the voice it landed on', () => {
      // Drew is detected — the run-on answer reading is what finds him — and
      // then refused, because 136 of SPEAKER_03's 148 seconds come before
      // "Drew." at 2317 s. Detecting and declining is the point: the name
      // reaches `suppressed` with a reason instead of vanishing.
      const declined = upTo(48).suppressed.find((entry) => entry.name === 'Drew');
      expect(declined?.reason).toBe('voice_speaks_mostly_before_introduction');
      expect(declined?.speaker).toBe('SPEAKER_03');
      // Not pinned to the exact share: it is a property of how the upstream
      // join draws its lines, and it has already moved 93 -> 94 -> 92 -> 75 as
      // that improved. What has to hold is that most of the voice predates the
      // introduction, which is what makes the label more than one person.
      const share = Number(/(\d+)%/.exec(declined?.detail ?? '')?.[1]);
      expect(share).toBeGreaterThan(50);
    });

    it('never loses a name it had already heard as the recording runs on', () => {
      // Vova used to survive to 38 minutes and vanish at 39, when a later
      // turn on the same voice was misread as a second introduction.
      const early = named(30);
      for (const [name, speaker] of early) expect(named(48).get(name)).toBe(speaker);
      expect(early.has('Vova')).toBe(true);
    });

    it('loses the two people who are only ever addressed by name', () => {
      // This is a regression against the retired fixture, not a passing grade,
      // and it is asserted so that fixing it trips the test. Both names are
      // found and both fall under NAME_SUGGESTION_MIN_CONFIDENCE, because the
      // join runs the answer on into the question: "Wait, Joshua, what are you
      // studying? Uh, English." is one line by one speaker, so there is no
      // separate turn for the addressee to land on. The cleanly segmented
      // fixture split that exchange in two, which is the only reason Joshua
      // used to be proposed at all.
      const heard = new Map(
        upTo(48).suppressed.map((entry) => [entry.name, entry] as const),
      );
      expect(heard.get('Joshua')?.reason).toBe('below_threshold');
      expect(heard.get('Joshua')?.confidence).toBeLessThan(NAME_SUGGESTION_MIN_CONFIDENCE);
      // The old fixture rendered her "Claire" and put her on a voice of her
      // own. Whisper hears "Clara", and the vocative lands on the wrong voice.
      expect(heard.get('Clara')?.reason).toBe('below_threshold');
    });

    it('keeps the owner out of it once the owner is known', () => {
      const owned = suggestNames({
        conversation_id: 'dorm-40min',
        turns: joinedTurns(),
        owner_name: 'Boris',
        owner_speaker: 'SPEAKER_04',
      });
      expect(owned.suggestions.some((suggestion) => suggestion.name === 'Boris')).toBe(false);
    });

    it('proposes no club, company, campus or person in the news', () => {
      const notPeople = [
        'Chelsea', 'Zelensky', 'Durov', 'Vestel', 'Gemini', 'Telegram', 'Berkeley', 'Stanford',
        'Luma', 'Haas', 'Cal', 'Transit',
      ];
      for (const word of notPeople) expect(named(48).has(word)).toBe(false);
    });
  },
);

/**
 * Diarization sometimes hands naming one label holding two people. Nothing
 * here can split that label — the defect is upstream in `server/audio` — but a
 * name put on the whole of it files most of somebody else's speech under the
 * wrong person, silently, which is worse than leaving the voice unnamed.
 */
describe('a voice that was already talking before it introduced itself', () => {
  const room = (lines: Array<[number, string, string]>) =>
    suggestNames({
      conversation_id: 'c',
      turns: lines.map(([second, speaker, text], index) => ({
        id: `u${index}`,
        speaker,
        text,
        start_ms: second * 1_000,
        end_ms: second * 1_000 + 10_000,
      })),
    });

  it('declines the name, and says why, when most of the voice predates it', () => {
    const result = room([
      [0, 's2', 'so anyway the bus was late'],
      [20, 's2', 'yeah I know right'],
      [40, 's2', 'that is what I said'],
      [60, 's1', "what's your name?"],
      [70, 's2', 'Drew.'],
    ]);
    expect(result.suggestions).toEqual([]);
    const declined = result.suppressed.find((entry) => entry.name === 'Drew');
    expect(declined?.reason).toBe('voice_speaks_mostly_before_introduction');
    expect(declined?.speaker).toBe('s2');
  });

  it('leaves an introduction alone when the voice is mostly still to come', () => {
    const result = room([
      [0, 's1', "what's your name?"],
      [10, 's2', 'Drew.'],
      [20, 's2', 'so anyway the bus was late'],
      [40, 's2', 'yeah I know right'],
      [60, 's2', 'that is what I said'],
    ]);
    expect(result.suggestions.map((suggestion) => [suggestion.name, suggestion.session_speaker])).toEqual([
      ['Drew', 's2'],
    ]);
  });

  it('says nothing about a voice that is only ever addressed by name', () => {
    // Being called by name carries no claim about when you arrived, so a voice
    // that has been talking all along is no reason to doubt it.
    const result = room([
      [0, 's2', 'so anyway the bus was late'],
      [20, 's2', 'yeah I know right'],
      [40, 's1', 'hey Drew, you good?'],
      [50, 's2', 'yeah I am fine'],
    ]);
    expect(result.suggestions.map((suggestion) => suggestion.session_speaker)).toEqual(['s2']);
  });
});

describe('two people whose names nearly match', () => {
  const room = (lines: [string, string][]) =>
    suggestNames({
      conversation_id: 'c',
      turns: lines.map(([speaker, text], index) => ({
        id: `u${index}`,
        speaker,
        text,
        start_ms: index * 3_000,
        end_ms: index * 3_000 + 2_500,
      })),
    });

  it('keeps both when two known names are one edit apart', () => {
    // Sara and Kara used to collapse into one person, and the loser vanished
    // without even reaching `suppressed`. There are 452 such pairs in the
    // given-name lexicon: brian/bryan, anna/anne, carl/carla, alex/alexa.
    const result = room([
      ['s1', "Hi, I'm Sara."],
      ['s2', "Nice to meet you. And I'm Kara."],
    ]);
    const byName = new Map(result.suggestions.map((s) => [s.name, s.session_speaker]));
    expect(byName.get('Sara')).toBe('s1');
    expect(byName.get('Kara')).toBe('s2');
  });

  it('still merges two spellings of one name on one voice', () => {
    // The behaviour the collapse existed for, which must survive the fix:
    // an unfamiliar name transcribed two ways for the same speaker.
    const result = room([
      ['s1', "I'm Vova."],
      ['s2', 'Nice to meet you Volva.'],
      ['s2', 'So Vova, where are you from?'],
    ]);
    const forS1 = result.suggestions.filter((s) => s.session_speaker === 's1');
    expect(forS1).toHaveLength(1);
  });

  it('never silently drops a name: anything not suggested is explained', () => {
    const result = room([
      ['s1', "Hi, I'm Erik."],
      ['s2', "I'm Eric, good to meet you."],
    ]);
    const names = new Set(result.suggestions.map((s) => s.name));
    expect(names.has('Erik')).toBe(true);
    expect(names.has('Eric')).toBe(true);
  });
});

describe('names outside the ASCII alphabet', () => {
  const introduce = (text: string) =>
    suggestNames({
      conversation_id: 'c',
      turns: [
        { id: 'u0', speaker: 's1', text, start_ms: 0, end_ms: 2_500 },
        { id: 'u1', speaker: 's2', text: 'Nice to meet you.', start_ms: 3_000, end_ms: 5_000 },
      ],
    });

  it('keeps an accented name whole rather than truncating it', () => {
    // "José" used to be offered to the user as "Jos" and "Zoë" as "Zo" — not
    // rejected, silently shortened into a different word.
    expect(introduce("Hi, I'm José.").suggestions.map((s) => s.name)).toContain('José');
    expect(introduce("I'm Zoë.").suggestions.map((s) => s.name)).toContain('Zoë');
  });

  it('declines a script it cannot read instead of proposing a fragment', () => {
    const names = introduce("Привет, I'm Даша.").suggestions.map((s) => s.name);
    for (const name of names) expect(name).not.toMatch(/^[\p{L}]{1,2}$/u);
  });
});
