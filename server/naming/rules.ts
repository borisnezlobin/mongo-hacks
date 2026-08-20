import {
  ANSWER_FILLERS,
  DEMONYMS,
  GIVEN_NAMES,
  NAME_QUESTION_PATTERNS,
  NON_PERSON_FOLLOWERS,
  NON_PERSON_PRECEDERS,
  ORGANISATION_CONTEXT,
  REMOTE_CONTACT_VERBS,
  STOP_WORDS,
  STRONG_VOCATIVE_CUES,
  THIRD_PERSON_VERBS,
  VOCATIVE_CUES,
} from './lexicon';
import { clauseAround, tokenize, titleCase, type SpeechToken } from './tokens';
import type { NameEvidenceKind, NamingTurn } from './types';

/**
 * How a name showed up. The contract only carries three kinds, but the way
 * people actually name each other has more shapes than that, and the shape
 * decides how much the evidence is worth and whether a rival reading is a
 * contradiction or a second voice agreeing.
 */
export type EvidenceFrame =
  | 'self_statement'
  | 'name_answer'
  | 'spelled'
  | 'address'
  | 'name_question'
  | 'presentation'
  | 'third_person';

/** Frames where the named person is the one talking. Nothing else comes close. */
export const FIRST_PERSON_FRAMES: ReadonlySet<EvidenceFrame> = new Set<EvidenceFrame>([
  'self_statement',
  'name_answer',
  'spelled',
]);

export interface RawMention {
  name: string;
  kind: NameEvidenceKind;
  frame: EvidenceFrame;
  turnIndex: number;
  evidence: string;
  strength: number;
  /** True when the wording addresses somebody directly rather than merely naming them. */
  strongCue: boolean;
  detail: string;
}

interface TokenizedTurn {
  turn: NamingTurn;
  tokens: SpeechToken[];
}

const THIRD_PERSON_PRECEDERS = new Set([
  'with', 'and', 'saw', 'met', 'about', 'like', 'told', 'ask', 'asked', ...REMOTE_CONTACT_VERBS,
]);

/** Turns this far after the question still count as the answer to it. */
const ANSWER_WINDOW_MS = 15_000;
const ANSWER_WINDOW_TURNS = 4;
/** An answer to "what's your name" is a name and almost nothing else. */
const ANSWER_MAX_TOKENS = 6;
/** A turn that is only the name: the shape of the turn corroborates the word. */
const BARE_ANSWER_STRENGTH = 0.85;
/** A name in the answer's position, in a turn diarization ran on past the answer. */
const RUN_ON_ANSWER_STRENGTH = 0.7;
/** How much an unfamiliar spelling can discount a first-person introduction. */
const UNFAMILIAR_NAME_FLOOR = 0.85;

/**
 * "I am Wizarding my freshman kids" is a verb, and the naming frames that
 * matter most are exactly the ones that swallow one whole: "I'm" in front of a
 * capitalised word the lexicon has never seen reads as the strongest evidence
 * there is. English marks its participles, so the suffix is the tell — but
 * only on a stem long enough to be a word of its own, which is what keeps Ming,
 * Jing and Ewing being names.
 */
const PRESENT_PARTICIPLE = /^\p{L}{3,}ing$/u;

export function tokenizeTurns(turns: NamingTurn[]): TokenizedTurn[] {
  return turns.map((turn) => ({ turn, tokens: tokenize(turn.text) }));
}

/**
 * Tokens the transcript itself shows are not people: "the transit app",
 * "top of Haas", "Luma Links". One appearance in a thing-shaped context is
 * enough to disqualify a word that is not a known given name, which is how
 * places and products get out of the way without a hand-written blocklist.
 */
function collectNonPersonTokens(tokenized: TokenizedTurn[]): Set<string> {
  const nonPerson = new Set<string>();
  for (const { tokens } of tokenized) {
    tokens.forEach((token, index) => {
      if (GIVEN_NAMES.has(token.key)) return;
      const previous = tokens[index - 1];
      const next = tokens[index + 1];
      const precededByThingMarker = previous !== undefined && NON_PERSON_PRECEDERS.has(previous.key);
      const followedByThingMarker = next !== undefined && NON_PERSON_FOLLOWERS.has(next.key);
      const followedByProperNoun =
        next !== undefined && next.capitalized && !next.sentenceInitial && !STOP_WORDS.has(next.key);
      if (precededByThingMarker || followedByThingMarker || followedByProperNoun) nonPerson.add(token.key);
    });
  }
  return nonPerson;
}

/**
 * Names spoken where the room is talking about clubs, teams and companies.
 * "Chelsea." is a perfectly formed vocative and also a football club, and the
 * fandom words in the turns either side are what tells them apart. This
 * discounts the mention rather than banning the word: people called Chelsea
 * exist, and they watch football too.
 */
function organisationTalk(tokenized: TokenizedTurn[]): (turnIndex: number) => boolean {
  const talking = tokenized.map(({ tokens }) => tokens.some((token) => ORGANISATION_CONTEXT.has(token.key)));
  return (turnIndex: number) =>
    talking[turnIndex - 1] === true || talking[turnIndex] === true || talking[turnIndex + 1] === true;
}

/** How much of a name a mention keeps when the room is discussing a club or a company. */
const ORGANISATION_DISCOUNT = 0.4;

interface NamePrior {
  score: number;
  /**
   * Whisper capitalises the first word of every turn, so a capitalised opener
   * is only a name when the sentence around it can only be about a name.
   */
  strongFrameOnly: boolean;
}

const NO_PRIOR: NamePrior = { score: 0, strongFrameOnly: false };

/**
 * How much a token looks like a name before any frame is considered.
 * Capitalisation alone is worth little — whisper capitalises turn starts and
 * random nouns — so a known given name outranks it, and a name the
 * transcriber left in lower case is worth less than one it capitalised.
 */
function namePrior(tokens: SpeechToken[], index: number, exclude: (key: string) => boolean): NamePrior {
  const token = tokens[index]!;
  if (token.word.length < 2 || token.word.length > 15) return NO_PRIOR;
  if (STOP_WORDS.has(token.key)) return NO_PRIOR;
  if (DEMONYMS.has(token.key)) return NO_PRIOR;
  if (exclude(token.key)) return NO_PRIOR;

  const known = GIVEN_NAMES.has(token.key);
  if (!known && PRESENT_PARTICIPLE.test(token.key)) return NO_PRIOR;
  const next = tokens[index + 1];
  if (next !== undefined && NON_PERSON_FOLLOWERS.has(next.key)) return NO_PRIOR;
  const partOfProperNounPhrase =
    next !== undefined && next.capitalized && !next.sentenceInitial && !STOP_WORDS.has(next.key);
  if (partOfProperNounPhrase && !known) return NO_PRIOR;

  if (known) return { score: token.capitalized ? 1 : 0.5, strongFrameOnly: false };
  if (token.capitalized && !token.sentenceInitial) return { score: 0.6, strongFrameOnly: false };
  if (token.capitalized) return { score: 0.55, strongFrameOnly: true };
  return NO_PRIOR;
}

function precededByThingMarker(tokens: SpeechToken[], index: number): boolean {
  const previous = tokens[index - 1];
  return previous !== undefined && NON_PERSON_PRECEDERS.has(previous.key);
}

interface FrameMatch {
  kind: NameEvidenceKind;
  frame: EvidenceFrame;
  strength: number;
  strongCue: boolean;
  detail: string;
}

function selfStatement(strength: number, detail: string): FrameMatch {
  return { kind: 'self_introduction', frame: 'self_statement', strength, strongCue: true, detail };
}

function matchIntroduction(tokens: SpeechToken[], index: number): FrameMatch | undefined {
  const previous = tokens[index - 1];
  if (previous === undefined) return undefined;
  const beforePrevious = tokens[index - 2];
  const twoBefore = tokens[index - 3];

  const isNameHead = previous.key === 'name' || (previous.key === 'is' && beforePrevious?.key === 'name');
  if (isNameHead) {
    const possessive = previous.key === 'name' ? beforePrevious : twoBefore;
    if (possessive?.key === 'my') return selfStatement(0.9, 'said "my name is"');
  }
  if (previous.key === 'im' || (previous.key === 'am' && beforePrevious?.key === 'i')) {
    return selfStatement(0.78, 'said "I\'m" before the name');
  }
  if (previous.key === 'me' && beforePrevious?.key === 'call') return selfStatement(0.85, 'said "call me"');
  if (previous.key === 'by' && beforePrevious?.key === 'go' && twoBefore?.key === 'i') {
    return selfStatement(0.85, 'said "I go by"');
  }
  // "This is Tarun" in a room introduces somebody else, and the person just
  // introduced is normally the next one to speak.
  if (previous.key === 'is' && (beforePrevious?.key === 'this' || beforePrevious?.key === 'that')) {
    return {
      kind: 'vocative',
      frame: 'presentation',
      strength: 0.55,
      strongCue: true,
      detail: `introduced with "${beforePrevious.word} is"`,
    };
  }
  return undefined;
}

/**
 * "You Boris?", "Are you Tarun?" — somebody checking a name they half know.
 * It does not prove the name, but the voice that answers is the voice the
 * name is about, and a real introduction nearby turns it into confirmation.
 */
function matchNameCheck(tokens: SpeechToken[], index: number): FrameMatch | undefined {
  const token = tokens[index]!;
  const previous = tokens[index - 1];
  if (previous === undefined) return undefined;
  const beforePrevious = tokens[index - 2];
  const addressesListener =
    previous.key === 'you' ||
    previous.key === 'youre' ||
    (previous.key === 'this' && beforePrevious?.key === 'is') ||
    (previous.key === 'it' && beforePrevious?.key === 'is');
  if (!addressesListener) return undefined;
  const next = tokens[index + 1];
  const questioned = token.trailingPunctuation.includes('?') || (next === undefined && index === tokens.length - 1);
  if (!questioned) return undefined;
  return {
    kind: 'vocative',
    frame: 'name_question',
    strength: 0.5,
    strongCue: true,
    detail: `asked "${previous.word} ${token.word}?"`,
  };
}

function matchVocative(tokens: SpeechToken[], index: number): FrameMatch | undefined {
  const token = tokens[index]!;
  const previous = tokens[index - 1];
  const next = tokens[index + 1];
  const setOffAfter = /[,?!.]/.test(token.trailingPunctuation) || next === undefined;
  const setOffBefore = previous === undefined || /[,?!.]/.test(previous.trailingPunctuation);

  if (previous !== undefined && VOCATIVE_CUES.has(previous.key)) {
    const strong = STRONG_VOCATIVE_CUES.has(previous.key);
    return {
      kind: 'vocative',
      frame: 'address',
      strength: strong ? 0.65 : 0.55,
      strongCue: strong,
      detail: `addressed after "${previous.word}"`,
    };
  }
  if (setOffBefore && setOffAfter) {
    return {
      kind: 'vocative',
      frame: 'address',
      strength: 0.6,
      strongCue: true,
      detail: 'name set off by punctuation at a turn boundary',
    };
  }
  return undefined;
}

function matchThirdPerson(tokens: SpeechToken[], index: number): FrameMatch | undefined {
  const previous = tokens[index - 1];
  const next = tokens[index + 1];
  if (next !== undefined && THIRD_PERSON_VERBS.has(next.key)) {
    return {
      kind: 'third_person_reference',
      frame: 'third_person',
      strength: 0.2,
      strongCue: false,
      detail: `spoken about ("${next.word}")`,
    };
  }
  if (previous !== undefined && THIRD_PERSON_PRECEDERS.has(previous.key)) {
    return {
      kind: 'third_person_reference',
      frame: 'third_person',
      strength: 0.2,
      strongCue: false,
      detail: `mentioned after "${previous.word}"`,
    };
  }
  return undefined;
}

interface NameQuestion {
  turnIndex: number;
  asker: string;
  end_ms: number;
  /** Character offset in the turn where the question ends, for answers glued into it. */
  askedUpTo: number;
}

function findNameQuestions(tokenized: TokenizedTurn[]): NameQuestion[] {
  const questions: NameQuestion[] = [];
  tokenized.forEach(({ turn }, turnIndex) => {
    let askedUpTo = -1;
    for (const pattern of NAME_QUESTION_PATTERNS) {
      const match = pattern.exec(turn.text);
      if (match !== null) askedUpTo = Math.max(askedUpTo, match.index + match[0].length);
    }
    if (askedUpTo < 0) return;
    questions.push({ turnIndex, asker: turn.speaker, end_ms: turn.end_ms, askedUpTo });
  });
  return questions;
}

/**
 * Everything in the turn except the name is filler. "Boris.", "uh Boris.",
 * "Sh I'm Vova." — the shape of an answer to "what's your name?".
 */
function isBareAnswer(tokens: SpeechToken[], index: number): boolean {
  if (tokens.length > ANSWER_MAX_TOKENS) return false;
  return tokens.every((token, position) => position === index || ANSWER_FILLERS.has(token.key));
}

/**
 * Diarization does not stop a turn where the answer stops. A reply of one word
 * routinely arrives glued to whatever was said next — "Drew What do you study
 * Applied math It was" is four people's worth of one label — and the answer is
 * lost because the turn around it is no longer answer-shaped.
 *
 * What survives the gluing is the position: the name still sits at the front,
 * behind nothing but filler. That is weaker evidence than a turn that is only
 * the name, because the run-on may be somebody else's speech merged in, so the
 * word itself has to look like a name rather than borrowing all its credibility
 * from the shape of the turn.
 */
function opensTheAnswer(tokens: SpeechToken[], index: number): boolean {
  if (!GIVEN_NAMES.has(tokens[index]!.key)) return false;
  return tokens.slice(0, index).every((token) => ANSWER_FILLERS.has(token.key));
}

interface AnswerHint {
  strength: number;
  detail: string;
}

/**
 * "What's your name?" and the reply to it. Strangers meet this way everywhere,
 * and the reply is the one moment somebody is trying to be understood, so it
 * is worth more than any amount of overheard third-party chatter.
 *
 * Overlapping speech sometimes glues the question and the answer into one
 * diarized turn. That reading is kept, at much less weight, because the turn's
 * own speaker is only one of the two people it contains.
 */
function answerHints(tokenized: TokenizedTurn[], questions: NameQuestion[]): Map<string, AnswerHint> {
  const hints = new Map<string, AnswerHint>();
  const remember = (turnIndex: number, tokenIndex: number, hint: AnswerHint) => {
    const key = `${turnIndex}:${tokenIndex}`;
    const existing = hints.get(key);
    if (existing === undefined || existing.strength < hint.strength) hints.set(key, hint);
  };

  for (const question of questions) {
    const asked = tokenized[question.turnIndex]!;
    asked.tokens.forEach((token, tokenIndex) => {
      if (token.start < question.askedUpTo) return;
      remember(question.turnIndex, tokenIndex, {
        strength: 0.45,
        detail: 'a name answering "what\'s your name?" inside an overlapped turn',
      });
    });

    for (let index = question.turnIndex + 1; index <= question.turnIndex + ANSWER_WINDOW_TURNS; index++) {
      const candidate = tokenized[index];
      if (candidate === undefined) break;
      if (candidate.turn.start_ms - question.end_ms > ANSWER_WINDOW_MS) break;
      if (candidate.turn.speaker === question.asker) continue;
      // A question gets one answer. Everything said after it is the
      // conversation moving on, however name-shaped it happens to look.
      const readings = candidate.tokens.map((_, tokenIndex) =>
        isBareAnswer(candidate.tokens, tokenIndex)
          ? BARE_ANSWER_STRENGTH
          : opensTheAnswer(candidate.tokens, tokenIndex)
            ? RUN_ON_ANSWER_STRENGTH
            : 0,
      );
      if (!readings.some((strength) => strength > 0)) continue;
      candidate.tokens.forEach((token, tokenIndex) => {
        const strength = readings[tokenIndex]!;
        if (strength === 0) return;
        // The question turn already containing the name means this turn is
        // repeating it back — confirmation of somebody else, not an answer.
        const echoed = asked.tokens.some((spoken) => spoken.key === token.key);
        remember(index, tokenIndex, {
          strength: echoed ? Math.min(strength, 0.4) : strength,
          detail: echoed
            ? 'repeated the name back while it was being asked about'
            : strength === BARE_ANSWER_STRENGTH
              ? 'answered "what\'s your name?" with a name and nothing else'
              : 'answered "what\'s your name?" before the turn ran on into the next thing said',
        });
      });
      break;
    }
  }
  return hints;
}

const NAME_TALK = /\bname\b|\bspell(?:ed|ing|s)?\b|\bcall\s+(?:you|me|him|her|them)\b/i;
/** How far from talk about names a spelled-out run is still about a name. */
const SPELLING_CONTEXT_MS = 45_000;
/**
 * People spell out names the listener could not catch, and those are long
 * names. A three-letter run is far more often a piece of a longer exchange that
 * diarization cut in half than a name somebody needed spelled: on the
 * 48-minute recording "R T" at 43 s and "E R T" at 1085 s are both fragments of
 * one interrupted spelling, arriving minutes apart on different voices.
 */
const SHORTEST_SPELLED_NAME = 4;

/**
 * People spell names the listener has not caught.
 *
 * Whisper writes dictated letters in capitals — "M A R T", "V O L V A" — and
 * the letters that turn up inside ordinary speech in lower case: "8 a m",
 * "11 p m". That casing is what separates a name being spelled from the
 * alphabet appearing mid-sentence, and it is a property of the transcriber
 * rather than of any one conversation. The retired realtime provider marked
 * spelling with separators instead ("M_A_R_T_"), and gating on those meant
 * this rule could not fire on anything the product actually produces.
 *
 * Two things about real spelling exchanges make them treacherous, and both are
 * visible in the 48-minute recording.
 *
 * The letters are interleaved with the other person repeating them back, and
 * diarization glues the two together: "M A R T M A R T" is one turn holding two
 * people. Reducing that to one copy means guessing which half was the
 * correction, so it is declined instead.
 *
 * And the person spelling is very often not the person being spelled. At
 * 2735 s somebody answers "how do you spell that?" about a man who left the
 * room six minutes earlier — the frame there is third-party reference, and
 * assuming self-introduction would put an absent man's name on the voice
 * describing him. So the frame is inferred from whether this speaker was
 * introducing themselves nearby, never assumed.
 */
function spelledRuns(
  tokenized: TokenizedTurn[],
  heard: RawMention[],
  questions: NameQuestion[],
): RawMention[] {
  const mentions: RawMention[] = [];
  const isDictatedLetter = (token: SpeechToken) => /^[A-Z]$/.test(token.word);

  const nameTalkAt = tokenized
    .filter(({ turn }) => NAME_TALK.test(turn.text))
    .map(({ turn }) => turn.start_ms);
  // Letters are dictated for course codes and acronyms all day long. They are
  // a name only when the exchange around them is about somebody's name.
  const aboutAName = (at: number) => nameTalkAt.some((spoken) => Math.abs(spoken - at) <= SPELLING_CONTEXT_MS);

  // "M A R T M A R T" — the speller and the person checking they heard it
  // right, in one diarized turn. Which copy is the correction is unknowable.
  const isEchoed = (letters: string) =>
    letters.length % 2 === 0 && letters.slice(0, letters.length / 2) === letters.slice(letters.length / 2);

  /**
   * Whether the letters are this speaker's own name. Two ways they can be:
   * the speaker was naming themselves in words around the same moment, or they
   * are answering somebody who just asked them their name — spelling it is
   * what people do when the spoken answer did not land. Anything else is a
   * person spelling a name that is not theirs.
   */
  const namingThemselves = (speaker: string, turnIndex: number, at: number) => {
    const inWords = heard.some((mention) => {
      if (!FIRST_PERSON_FRAMES.has(mention.frame)) return false;
      const spoken = tokenized[mention.turnIndex]!.turn;
      return spoken.speaker === speaker && Math.abs(spoken.start_ms - at) <= SPELLING_CONTEXT_MS;
    });
    if (inWords) return true;
    return questions.some(
      (question) =>
        question.asker !== speaker &&
        turnIndex > question.turnIndex &&
        turnIndex <= question.turnIndex + ANSWER_WINDOW_TURNS &&
        at - question.end_ms <= ANSWER_WINDOW_MS,
    );
  };

  tokenized.forEach(({ turn, tokens }, turnIndex) => {
    if (!aboutAName(turn.start_ms)) return;
    let run: SpeechToken[] = [];
    const flush = () => {
      const letters = run.map((token) => token.word.toLowerCase()).join('');
      run = [];
      if (letters.length < SHORTEST_SPELLED_NAME || letters.length > 12) return;
      if (!/[aeiouy]/.test(letters)) return;
      if (!/[^aeiouy]/.test(letters)) return;
      if (new Set(letters).size < 3) return;
      if (isEchoed(letters)) return;
      if (STOP_WORDS.has(letters)) return;

      // Spelling says how a name is written, not whose it is. Only a speaker
      // who was naming themselves nearby is claiming the spelling for their
      // own voice; anybody else is spelling somebody else's name, and who that
      // is has to come from evidence other than the letters.
      const own = namingThemselves(turn.speaker, turnIndex, turn.start_ms);
      mentions.push({
        name: titleCase(letters),
        kind: own ? 'self_introduction' : 'third_person_reference',
        frame: own ? 'spelled' : 'third_person',
        turnIndex,
        evidence: turn.text.trim(),
        strength: GIVEN_NAMES.has(letters) ? 0.5 : 0.45,
        strongCue: own,
        detail: own
          ? 'spelled the name out letter by letter while introducing themselves'
          : 'spelled out a name, but was not naming themselves',
      });
    };
    for (const token of tokens) {
      if (isDictatedLetter(token)) run.push(token);
      else flush();
    }
    flush();
  });
  return mentions;
}

export function extractRawMentions(tokenized: TokenizedTurn[]): RawMention[] {
  const nonPersonTokens = collectNonPersonTokens(tokenized);
  const nearOrganisationTalk = organisationTalk(tokenized);
  const excluded = (key: string) => nonPersonTokens.has(key);
  const questions = findNameQuestions(tokenized);
  const hints = answerHints(tokenized, questions);
  const mentions: RawMention[] = [];

  tokenized.forEach(({ turn, tokens }, turnIndex) => {
    tokens.forEach((token, index) => {
      const prior = namePrior(tokens, index, excluded);
      if (prior.score === 0) return;

      const hint = hints.get(`${turnIndex}:${index}`);
      const answer: FrameMatch | undefined =
        hint === undefined
          ? undefined
          : {
              kind: 'self_introduction',
              frame: 'name_answer',
              strength: hint.strength,
              strongCue: true,
              detail: hint.detail,
            };
      const introduced = matchIntroduction(tokens, index);
      // Answering the question and saying "I'm …" in the same breath is one
      // introduction, not two, and it is worth whichever reading is stronger.
      const introduction =
        answer !== undefined && introduced?.frame === 'self_statement'
          ? { ...answer, strength: Math.max(answer.strength, introduced.strength) }
          : answer ?? introduced;

      const frame =
        introduction ??
        (precededByThingMarker(tokens, index)
          ? undefined
          : matchNameCheck(tokens, index) ?? matchVocative(tokens, index) ?? matchThirdPerson(tokens, index));
      if (frame === undefined) return;
      const firstPerson = FIRST_PERSON_FRAMES.has(frame.frame);
      if (prior.strongFrameOnly && !firstPerson) return;
      // Somebody stating their own name carries the certainty themselves; the
      // spelling being unfamiliar is the normal case, not a reason to doubt it.
      const weight =
        (firstPerson ? Math.max(prior.score, UNFAMILIAR_NAME_FLOOR) : prior.score) *
        (!firstPerson && nearOrganisationTalk(turnIndex) ? ORGANISATION_DISCOUNT : 1);

      mentions.push({
        name: titleCase(token.key),
        kind: frame.kind,
        frame: frame.frame,
        turnIndex,
        evidence: clauseAround(turn.text, tokens, index),
        strength: frame.strength * weight,
        strongCue: frame.strongCue,
        detail: frame.detail,
      });
    });
  });

  return [...mentions, ...spelledRuns(tokenized, mentions, questions)];
}
