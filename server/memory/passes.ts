import { OWNER_ID } from '../../shared/contracts';
import type { Id, Person, Utterance } from '../../shared/contracts';
import type { AmeliaBus } from '../lib/bus';
import { collections } from './db';
import { extractStructured } from './llm';
import {
  EXTRACTABLE_FACT_ATTRIBUTES,
  canonicalFactAttribute,
  normalizeClaim,
  resolveTonight,
  todayIsoDate,
} from './normalize';
import {
  WINDOW_MIN_CONTENT_WORDS,
  coalesceTurns,
  splitIntoWindows,
  windowContentWords,
  type CoalescedTurn,
} from './window';
import {
  findFactBySourceClaim,
  getPerson,
  recordFact,
  recordPromise,
  resolveFactState,
} from './store';

/** A turn as the model sees it: the speaker label matters as much as the words. */
interface LabelledTurn {
  turn_id: Id;
  speaker: string;
  person_id?: Id;
  text: string;
}

export interface WindowSpeaker {
  person_id: Id;
  label: string;
  named: boolean;
  name: string;
  /**
   * Every turn this person spoke in this window carries a settled identity.
   *
   * Not "some of them". The verified diarization evaluation on a real recording
   * merges two people into one voice and splits a third across two, so a person
   * who is confidently identified for part of a window and merely guessed at for
   * the rest is exactly the case that files a real fact under the wrong human.
   */
  confirmed: boolean;
}

export interface LabelledWindow {
  turns: LabelledTurn[];
  /** turn_id -> the coalesced turn it came from, for gating the model's citations. */
  turnsById: Map<Id, CoalescedTurn>;
  speakersById: Map<Id, WindowSpeaker>;
  /** Every word said in the window, normalized, for grounding evidence quotes. */
  normalizedText: string;
}

/**
 * Whether every word attributed to this person in this window came with a
 * settled identity.
 *
 * A missing `identity_confidence` counts as not settled. Rows written before the
 * field existed have no claim to being confirmed, and defaulting the other way
 * would quietly exempt exactly the data the field was added to protect.
 */
function identityIsSettled(utterances: Utterance[], personId: Id): boolean {
  const theirs = utterances.filter((utterance) => utterance.person_id === personId);
  return theirs.length > 0 && theirs.every((utterance) => utterance.identity_confidence === 'confirmed');
}

/**
 * A voice we can tell apart but cannot name yet still deserves a stable label
 * within one window, or the model reads two strangers as one person.
 */
function anonymousLabel(index: number): string {
  return `Unidentified speaker ${index + 1}`;
}

export async function labelWindow(utterances: Utterance[]): Promise<LabelledWindow> {
  const turns = coalesceTurns(utterances);
  const people = new Map<Id, Person | null>();
  for (const personId of new Set(turns.flatMap((turn) => (turn.person_id ? [turn.person_id] : [])))) {
    people.set(personId, await getPerson(personId));
  }

  const speakersById = new Map<Id, WindowSpeaker>();
  let anonymousCount = 0;
  for (const [personId, person] of people) {
    const named = Boolean(person?.name) && person?.is_unnamed !== true;
    speakersById.set(personId, {
      person_id: personId,
      named,
      name: person?.name ?? '',
      label: named ? (person?.name as string) : anonymousLabel(anonymousCount++),
      confirmed: identityIsSettled(utterances, personId),
    });
  }

  const labelled = turns.map((turn) => {
    const speaker = turn.person_id ? speakersById.get(turn.person_id) : undefined;
    return {
      turn_id: turn.utterance_id,
      speaker: speaker?.label ?? 'Unattributed speech',
      ...(speaker ? { person_id: speaker.person_id } : {}),
      text: turn.text,
    };
  });

  return {
    turns: labelled,
    turnsById: new Map(turns.map((turn) => [turn.utterance_id, turn])),
    speakersById,
    normalizedText: normalizeClaim(turns.map((turn) => turn.text).join(' ')),
  };
}

const FACT_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['person_id', 'attribute', 'claim', 'source_turn_id', 'subject_is_speaker', 'evidence_quote'],
  properties: {
    person_id: { type: 'string' },
    attribute: { type: 'string', enum: EXTRACTABLE_FACT_ATTRIBUTES },
    claim: { type: 'string' },
    source_turn_id: { type: 'string' },
    subject_is_speaker: { type: 'boolean' },
    evidence_quote: { type: 'string' },
  },
} as const;

const WINDOW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['promises', 'facts'],
  properties: {
    promises: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['speaker_person_id', 'source_turn_id', 'text', 'evidence_quote'],
        properties: {
          speaker_person_id: { type: 'string' },
          source_turn_id: { type: 'string' },
          text: { type: 'string' },
          evidence_quote: { type: 'string' },
          due_at: { type: 'string' },
          due_phrase: { type: 'string' },
        },
      },
    },
    facts: { type: 'array', items: FACT_ITEM_SCHEMA },
  },
} as const;

interface RawFact {
  person_id: string;
  attribute: string;
  claim: string;
  source_turn_id: string;
  subject_is_speaker: boolean;
  evidence_quote: string;
}

interface RawPromise {
  speaker_person_id: string;
  source_turn_id: string;
  text: string;
  evidence_quote: string;
  due_at?: string;
  due_phrase?: string;
}

export interface WindowExtraction {
  promises: RawPromise[];
  facts: RawFact[];
}

export interface FactCandidate {
  person_id: string;
  attribute: string;
  claim: string;
  primary_source_utterance_id: string;
}

const WINDOW_SYSTEM = `You extract durable facts and commitments from a stretch of a transcribed conversation.

The transcript is real speech: people interrupt, restart, swear, and the transcriber
mangles unfamiliar names. Fragments like "Yeah.", "Wait, what?" and half-finished
sentences are normal and carry nothing. A fact is frequently spread over several
consecutive turns, or given as an answer to somebody else's question — read the
window as a whole, not turn by turn.

A fact is something you could still tell somebody a month from now and be right:
where someone is from, where they live, what they study or do, what they are
building, who their family are, what they like. Apply that month test to every
candidate before you write it.

These are NOT facts, however true they are right now:
- what somebody is doing, holding, wearing or where they are standing at this moment
- what happened once today, or an errand, or a plan for the next few hours
- something a person does not have, does not know, or did not do, unless the absence
  is itself a lasting thing about them
- a passing opinion about the conversation, a joke, or a hypothetical
- anything about somebody who is not in this conversation

There is no attribute for "miscellaneous". If what you found does not fit one of the
attributes in the enum, it is not a fact — leave it out.

A promise is a commitment the speaker makes about their own future action, specific
enough that the other person could later ask whether it happened. All three must
hold: first person, future tense, and a named deliverable. "I'll send you the photos
tonight" is a promise. "We should get dinner sometime", "I sent it yesterday",
"I'll ask", "I'll come back" and "I'll go to sleep" are not — the last three commit
to nothing anybody would follow up on. Resolve relative dates against today's date,
given below, and return ISO 8601 in due_at, keeping the speaker's own wording in
due_phrase. Only fill those fields when the sentence actually carries a time.

ATTRIBUTION IS THE THING YOU MUST NOT GET WRONG. Filing a real fact under the wrong
person is far worse than missing it. Therefore:
- person_id must be one of the person_id values in the labelled turns. Never invent one.
- Set subject_is_speaker true only when the person the fact is about is the speaker of
  the turn you cite.
- If the fact is about somebody else, set subject_is_speaker false, and only do this
  when the transcript names that person explicitly. "He's a sophomore", where "he"
  is a guess about which of several people is meant, must be skipped entirely.
- A turn whose speaker is labelled "Unidentified speaker" or "Unattributed speech" has
  no person_id. Never attach a fact or a promise to one.
- When two readings of who is meant are both plausible, extract nothing.

evidence_quote must be copied verbatim from the turns below — the exact words that
make the claim true. Do not paraphrase it and do not write a quote that is not in
the transcript.

Attribute is the slot the claim occupies, chosen from the enum. Two claims share an
attribute only when the newer one could replace the older.

Write each claim as one standalone third-person sentence that opens with the
speaker's label exactly as it is spelled in the turns below, so that the same fact
extracted twice comes out worded the same way. Do not add anything the transcript
does not say, and do not soften a claim you are unsure of — drop it instead.

source_turn_id must be the turn_id of the turn the claim came from.

Most windows of real conversation contain nothing durable. Returning
{"promises": [], "facts": []} is the ordinary, correct answer — do not manufacture
memories to fill the array.`;

function evidenceIsGrounded(quote: string, normalizedWindowText: string): boolean {
  const normalizedQuote = normalizeClaim(quote);
  if (!normalizedQuote) return false;
  if (normalizedWindowText.includes(normalizedQuote)) return true;
  // Transcript punctuation and the model's line breaks make an exact match
  // brittle; requiring every word of the quote to be present still makes an
  // invented sentence essentially impossible to sneak through.
  const words = normalizedQuote.split(' ');
  return words.every((word) => normalizedWindowText.includes(word));
}

/**
 * A claim has to say who it is about.
 *
 * Replaying a real recording, 11% of everything the model returned was a bare
 * fragment — "sophomore", "bought the domain", "does not speak German" — with
 * the subject left in the prompt rather than in the claim. Stored, those are
 * unreadable in a profile and unsearchable, and two of them in that run
 * contradicted each other about the same person with no way to tell which
 * belonged to whom. The prompt asks for the speaker's label at the front of
 * every claim; this is the check that it is there.
 */
function claimNamesItsSubject(claim: string, speaker: WindowSpeaker): boolean {
  const label = normalizeClaim(speaker.label);
  if (!label) return false;
  return normalizeClaim(claim).includes(label);
}

/**
 * A fact about somebody other than the current speaker is the single most
 * dangerous thing this extractor produces: "he's a sophomore" is filed forever
 * against whichever person the model guessed the pronoun meant. We accept it
 * only when the subject is a person we can already name and that name is
 * actually spoken in the window, which is the one case where the referent is
 * not a guess.
 */
function thirdPartySubjectIsIdentified(speaker: WindowSpeaker | undefined, normalizedWindowText: string): boolean {
  if (!speaker?.named) return false;
  const nameTokens = normalizeClaim(speaker.name).split(' ').filter((token) => token.length >= 3);
  if (nameTokens.length === 0) return false;
  return nameTokens.some((token) => normalizedWindowText.includes(token));
}

/**
 * Everything the model returned that survives the attribution gates. Kept
 * separate from recording so the rules can be tested without a database.
 */
export function admissibleFacts(extraction: WindowExtraction, window: LabelledWindow): FactCandidate[] {
  const admitted: FactCandidate[] = [];
  for (const raw of extraction.facts) {
    const turn = window.turnsById.get(raw.source_turn_id);
    if (!turn) continue;
    const subject = window.speakersById.get(raw.person_id);
    if (!subject) continue;
    // Attribution is the weakest link in the system, not the strongest: the
    // evaluation harness still merges two speakers and splits a third on real
    // audio. A wrong fact about a real friend is the failure the owner never
    // catches, so an unsettled identity means nothing is written at all.
    if (!subject.confirmed) continue;
    if (!evidenceIsGrounded(raw.evidence_quote, window.normalizedText)) continue;
    if (raw.subject_is_speaker) {
      if (turn.person_id !== raw.person_id) continue;
    } else if (!thirdPartySubjectIsIdentified(subject, window.normalizedText)) {
      continue;
    }
    if (!claimNamesItsSubject(raw.claim, subject)) continue;
    admitted.push({
      person_id: raw.person_id,
      attribute: canonicalFactAttribute(raw.attribute),
      claim: raw.claim.trim(),
      primary_source_utterance_id: turn.utterance_id,
    });
  }
  return admitted;
}

export interface PromiseCandidate {
  person_id: string;
  source_utterance_id: string;
  text: string;
  due_at?: string;
  due_phrase?: string;
}

export function admissiblePromises(extraction: WindowExtraction, window: LabelledWindow): PromiseCandidate[] {
  const admitted: PromiseCandidate[] = [];
  for (const raw of extraction.promises) {
    const turn = window.turnsById.get(raw.source_turn_id);
    if (!turn) continue;
    // A promise is by definition the speaker's own commitment, so the cited
    // turn must be theirs. Anything else is a promise put in someone's mouth.
    if (!turn.person_id || turn.person_id !== raw.speaker_person_id) continue;
    const speaker = window.speakersById.get(raw.speaker_person_id);
    if (!speaker?.confirmed) continue;
    if (!evidenceIsGrounded(raw.evidence_quote, window.normalizedText)) continue;
    if (!raw.text.trim()) continue;
    admitted.push({
      person_id: raw.speaker_person_id,
      source_utterance_id: turn.utterance_id,
      text: raw.text.trim(),
      ...(raw.due_at ? { due_at: raw.due_at } : {}),
      ...(raw.due_phrase ? { due_phrase: raw.due_phrase } : {}),
    });
  }
  return admitted;
}

/**
 * One unit of extraction work: one LLM call over a window of turns, however
 * many utterances that window happens to contain.
 */
export async function runWindowPass(bus: AmeliaBus, utterances: Utterance[]): Promise<boolean> {
  if (utterances.length === 0) return false;
  if (windowContentWords(utterances) < WINDOW_MIN_CONTENT_WORDS) return false;

  const window = await labelWindow(utterances);
  if (window.turns.length === 0) return false;

  const extraction = await extractStructured<WindowExtraction>({
    system: WINDOW_SYSTEM,
    user: [
      `Today's date is ${todayIsoDate()}. "tonight" resolves to ${resolveTonight()}.`,
      '',
      'Turns:',
      JSON.stringify(window.turns, null, 1),
    ].join('\n'),
    schema: WINDOW_SCHEMA,
    // The extraction model reasons before it answers and those tokens count
    // against the cap. A window is up to ~3,500 characters of transcript, and
    // 4,000 tokens was not enough room to think about that much speech and
    // still emit the object — replaying the real recording died on
    // `finish_reason: length` partway through.
    maxTokens: 12_000,
  });

  for (const promise of admissiblePromises(extraction, window)) {
    await recordPromise(bus, promise);
  }
  for (const candidate of admissibleFacts(extraction, window)) {
    await reconcileFactCandidate(bus, candidate);
  }
  return true;
}

const ADJUDICATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['relation', 'reason'],
  properties: {
    relation: { type: 'string', enum: ['replace', 'refine', 'coexist'] },
    reason: { type: 'string' },
  },
} as const;

const ADJUDICATION_SYSTEM = `Two claims share an attribute for the same person. Decide how they relate.

- replace: the new claim states a changed reality — the old one is no longer true.
  A move date pushed from September 1 to September 15 is a replace.
- refine: the new claim is the same reality, stated with more detail. Keep the
  original date the fact was first stated.
- coexist: both are true at once and neither supersedes the other. Two unrelated
  preferences that happen to share the "preference" slot coexist.

When the claims describe the same underlying thing and the new one contradicts the
old, choose replace. Do not choose coexist merely because you are unsure.`;

async function candidatePredatesCurrent(candidate: FactCandidate, currentSourceUtteranceId: Id): Promise<boolean> {
  // One sentence cannot contradict itself, so two differing claims citing the
  // same turn are two facts, not a change of state. This used to return true
  // here and drop the second one, which silently lost the sorority half of
  // "I don't want to walk to school in the dark, and I'm not down to be in a
  // sorority" — one utterance, two preferences, one slot. Let the adjudicator
  // decide whether they coexist or one refines the other.
  if (candidate.primary_source_utterance_id === currentSourceUtteranceId) return false;
  const [candidateSource, currentSource] = await Promise.all([
    collections.utterances().findOne({ _id: candidate.primary_source_utterance_id, owner_id: OWNER_ID }),
    collections.utterances().findOne({ _id: currentSourceUtteranceId, owner_id: OWNER_ID }),
  ]);
  if (!candidateSource || !currentSource) return false;
  if (candidateSource.conversation_id === currentSource.conversation_id) {
    return candidateSource.start_ms <= currentSource.start_ms;
  }
  // Replaying an older conversation must not roll back a fact learned later.
  return candidateSource.created_at <= currentSource.created_at;
}

/** Shared by the live window pass and the closing sweep so both apply identical temporal rules. */
export async function reconcileFactCandidate(bus: AmeliaBus, candidate: FactCandidate): Promise<void> {
  const alreadyRecorded = await findFactBySourceClaim(candidate.primary_source_utterance_id, candidate.claim);
  if (alreadyRecorded) return;

  const current = await resolveFactState(candidate.person_id, candidate.attribute);
  if (!current) {
    await recordFact(bus, candidate);
    return;
  }
  if (current.claim_normalized === normalizeClaim(candidate.claim)) return;
  if (await candidatePredatesCurrent(candidate, current.primary_source_utterance_id)) return;

  const adjudication = await extractStructured<{ relation: 'replace' | 'refine' | 'coexist'; reason: string }>({
    system: ADJUDICATION_SYSTEM,
    user: [
      `Person: ${candidate.person_id}`,
      `Attribute: ${candidate.attribute}`,
      `Existing claim (stated ${current.valid_from}): ${current.claim}`,
      `New claim: ${candidate.claim}`,
    ].join('\n'),
    schema: ADJUDICATION_SCHEMA,
  });

  if (adjudication.relation === 'coexist') {
    await recordFact(bus, candidate);
    return;
  }
  await recordFact(bus, {
    ...candidate,
    supersedes: current._id,
    ...(adjudication.relation === 'refine' ? { valid_from: current.valid_from } : {}),
  });
}

/**
 * The closing sweep over a whole conversation.
 *
 * The live pass sees the conversation a minute at a time, so a fact that only
 * becomes legible with more context around it — a name established twenty
 * minutes after the person it belongs to — is missed. The sweep re-reads
 * everything in wider windows. Its windows are deliberately larger than the
 * live ones: the sweep is not racing the speech, so it trades calls for
 * context. Re-extracting the same sentence is free, because the idempotency
 * index on (source utterance, normalized claim) collapses it.
 */
const SWEEP_CHAR_BUDGET = 7_000;
const SWEEP_OVERLAP_CHARS = 1_500;

export async function runSlowPass(bus: AmeliaBus, conversationId: Id): Promise<void> {
  const utterances = await collections
    .utterances()
    .find({ owner_id: OWNER_ID, conversation_id: conversationId })
    .sort({ start_ms: 1 })
    .toArray();
  if (utterances.length === 0) return;

  for (const window of splitIntoWindows(utterances, SWEEP_CHAR_BUDGET, SWEEP_OVERLAP_CHARS)) {
    await runWindowPass(bus, window);
  }
}
