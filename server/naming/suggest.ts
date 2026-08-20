import { NAME_SUGGESTION_MIN_CONFIDENCE, type NameSuggestionEvent } from '../../shared/contracts';
import { attributeMentions } from './attribute';
import { GIVEN_NAMES } from './lexicon';
import { extractRawMentions, tokenizeTurns, FIRST_PERSON_FRAMES, type EvidenceFrame } from './rules';
import { editDistance } from './tokens';
import type {
  NameMention,
  NamingContext,
  NamingResult,
  NamingTurn,
  SuppressedSuggestion,
  SuppressionReason,
} from './types';

const MAX_CONFIDENCE = 0.95;
/** Each extra mention closes this share of the gap to certainty. */
const CORROBORATION_GAIN = 0.6;
/**
 * How far either side of somebody stating their own name the room is still
 * talking about that introduction rather than about a second person who
 * happens to share the name.
 */
const ECHO_WINDOW_MS = 300_000;
/** A name that is also being discussed as an absent third party is worth less. */
const DISCUSSED_ELSEWHERE_PENALTY = 0.7;

/**
 * Evidence about somebody's name, ranked by how directly it comes from them.
 * A guess about who a vocative was aimed at cannot outrank the person saying
 * their own name out loud, and the two are not in contradiction anyway.
 */
const FRAME_TIER: Record<EvidenceFrame, number> = {
  self_statement: 3,
  name_answer: 3,
  // A name reconstructed from spelled-out letters says who is talking, but
  // whisper mangles dictated letters worse than it mangles words, so spelling
  // corroborates a name that was also heard and never argues with one.
  spelled: 1,
  address: 2,
  name_question: 2,
  presentation: 2,
  third_person: 1,
};

/**
 * Whisper spells unfamiliar names differently each time it hears them, so two
 * spellings one edit apart can be one person. They can equally be two people:
 * Sara and Kara, Erik and Eric, Brian and Bryan, Anna and Anne. There are 452
 * such pairs inside this repository's own given-name list.
 *
 * Two rules keep those apart, and both matter.
 *
 * Names that are BOTH known given names are never merged. Two real names is
 * evidence of two people, not of one person transcribed badly. The previous
 * version had this backwards: a bonus for being in the lexicon meant a genuine
 * out-of-lexicon name always lost to whatever in-lexicon word the transcriber
 * misheard it as.
 *
 * And merging only happens WITHIN one voice. Two spellings on one voice are a
 * transcription wobble; the same two spellings on two voices are two people
 * introducing themselves. Judging it globally is what let one of them vanish,
 * and vanish silently, because a rewritten mention leaves nothing behind to
 * suppress or explain.
 */
export function canonicalizeNames(mentions: NameMention[]): NameMention[] {
  const groups = new Map<string, NameMention[]>();
  for (const mention of mentions) {
    const voice = mention.target ?? `untargeted:${mention.speaker}`;
    groups.set(voice, [...(groups.get(voice) ?? []), mention]);
  }

  const rewritten = new Map<NameMention, string>();
  for (const group of groups.values()) {
    const counts = new Map<string, number>();
    for (const mention of group) counts.set(mention.name, (counts.get(mention.name) ?? 0) + 1);
    const names = [...counts.keys()];
    for (const name of names) {
      let best = name;
      for (const other of names) {
        if (other === name || Math.min(name.length, other.length) < 4) continue;
        if (editDistance(name.toLowerCase(), other.toLowerCase()) > 1) continue;
        if (GIVEN_NAMES.has(name.toLowerCase()) && GIVEN_NAMES.has(other.toLowerCase())) continue;
        const rank = (candidate: string) =>
          (GIVEN_NAMES.has(candidate.toLowerCase()) ? 100 : 0) + (counts.get(candidate) ?? 0);
        if (rank(other) > rank(best)) best = other;
      }
      if (best !== name) {
        for (const mention of group) if (mention.name === name) rewritten.set(mention, best);
      }
    }
  }
  return mentions.map((mention) => {
    const canonical = rewritten.get(mention);
    return canonical ? { ...mention, name: canonical } : mention;
  });
}

interface Claim {
  name: string;
  target?: string;
  confidence: number;
  mentions: NameMention[];
}

function tierOf(claim: Claim): number {
  return Math.max(...claim.mentions.map((mention) => FRAME_TIER[mention.frame]));
}

/**
 * Somebody saying "I'm Boris" settles the question. Being asked "you Boris?"
 * and hearing the name repeated back around that moment is the room agreeing,
 * not a second Boris, so those mentions are moved onto the voice that
 * introduced itself instead of competing with it.
 */
function anchorEchoes(mentions: NameMention[], turns: NamingTurn[]): NameMention[] {
  const startOf = new Map(turns.map((turn) => [turn.id, turn.start_ms]));
  const anchors = new Map<string, NameMention>();
  for (const mention of mentions) {
    if (!FIRST_PERSON_FRAMES.has(mention.frame) || mention.target === undefined) continue;
    const held = anchors.get(mention.name);
    if (held === undefined || mention.strength > held.strength) anchors.set(mention.name, mention);
  }

  return mentions.map((mention) => {
    const anchor = anchors.get(mention.name);
    if (anchor === undefined || anchor === mention) return mention;
    if (mention.target === undefined || mention.target === anchor.target) return mention;
    if (mention.strength > anchor.strength) return mention;
    const apart = Math.abs((startOf.get(mention.turn_id) ?? 0) - (startOf.get(anchor.turn_id) ?? 0));
    if (apart > ECHO_WINDOW_MS) return mention;
    return {
      ...mention,
      target: anchor.target,
      reasoning: `${mention.reasoning}; read as the room echoing the voice that introduced itself as ${anchor.name}`,
    };
  });
}

function combine(strengths: number[]): number {
  const sorted = [...strengths].sort((a, b) => b - a);
  let confidence = 0;
  for (const strength of sorted) confidence += strength * (1 - confidence) * (confidence === 0 ? 1 : CORROBORATION_GAIN);
  return Math.min(confidence, MAX_CONFIDENCE);
}

function buildClaims(mentions: NameMention[]): Claim[] {
  const grouped = new Map<string, NameMention[]>();
  for (const mention of mentions) {
    const key = `${mention.target ?? ''}::${mention.name}`;
    const bucket = grouped.get(key);
    if (bucket === undefined) grouped.set(key, [mention]);
    else if (!bucket.some((existing) => existing.turn_id === mention.turn_id)) bucket.push(mention);
    else {
      const weakest = bucket.findIndex((existing) => existing.turn_id === mention.turn_id);
      if (bucket[weakest]!.strength < mention.strength) bucket[weakest] = mention;
    }
  }

  return [...grouped.values()].map((bucket) => {
    const best = bucket.reduce((a, b) => (b.strength > a.strength ? b : a));
    return {
      name: best.name,
      target: best.target,
      confidence: combine(bucket.map((mention) => mention.strength)),
      mentions: bucket,
    };
  });
}

/**
 * One name cannot belong to two voices, and one voice answers to one name.
 * When two readings of the same standing disagree it is evidence the detector
 * misread the room, so both lose value rather than the louder one winning.
 * A reading that outranks its rival is not in doubt at all: an overheard
 * vocative losing to a self-introduction is the system working.
 */
function applyContradictions(claims: Claim[], mentions: NameMention[]): Claim[] {
  const discussed = new Set(
    mentions.filter((mention) => mention.frame === 'third_person').map((mention) => mention.name),
  );

  return claims.map((claim) => {
    const tier = tierOf(claim);
    const talkedAbout = tier < FRAME_TIER.self_statement && discussed.has(claim.name);
    const discount = talkedAbout ? DISCUSSED_ELSEWHERE_PENALTY : 1;
    if (claim.target === undefined) return { ...claim, confidence: claim.confidence * discount };

    const rival = (other: Claim) => other !== claim && other.target !== undefined;
    const sameName = claims.filter((other) => rival(other) && other.name === claim.name && other.target !== claim.target);
    const sameVoice = claims.filter((other) => rival(other) && other.target === claim.target && other.name !== claim.name);

    const outranking = [...sameName, ...sameVoice].filter((other) => tierOf(other) > tier);
    if (outranking.length > 0) return { ...claim, confidence: claim.confidence * 0.3 * discount };

    const peers = (rivals: Claim[]) => rivals.filter((other) => tierOf(other) === tier);
    // The same name landing on two voices means the addressee reasoning is
    // unreliable for this name, so even a faint rival reading costs the
    // winner: proposing the wrong human is the expensive mistake here.
    const namedTwice = peers(sameName);
    const namedTwiceDamp =
      namedTwice.length === 0 ? 1 : Math.max(...namedTwice.map((other) => other.confidence)) >= claim.confidence ? 0.4 : 0.6;

    const calledTwo = peers(sameVoice);
    const ratio = calledTwo.length === 0 ? 0 : Math.max(...calledTwo.map((other) => other.confidence)) / claim.confidence;
    const calledTwoDamp = calledTwo.length === 0 ? 1 : ratio >= 1 ? 0.4 : ratio >= 0.6 ? 0.6 : 0.85;

    return { ...claim, confidence: claim.confidence * namedTwiceDamp * calledTwoDamp * discount };
  });
}

/**
 * One voice will not be both Clara and Claire. When two near-miss spellings
 * land on the same voice, whisper heard the same sound twice, and the better
 * supported spelling should carry all of the evidence rather than half of it.
 */
function mergeVariants(claims: Claim[]): Claim[] {
  const merged: Claim[] = [];
  for (const claim of claims.sort((a, b) => b.confidence - a.confidence)) {
    const sibling = merged.find((kept) => {
      if (kept.target === undefined || kept.target !== claim.target) return false;
      const a = kept.name.toLowerCase();
      const b = claim.name.toLowerCase();
      if (a[0] !== b[0]) return false;
      const shortest = Math.min(a.length, b.length);
      if (shortest < 4) return false;
      return editDistance(a, b) <= (shortest >= 5 ? 2 : 1);
    });
    if (sibling === undefined) {
      merged.push({ ...claim });
      continue;
    }
    sibling.mentions = [...sibling.mentions, ...claim.mentions];
    sibling.confidence = combine(sibling.mentions.map((mention) => mention.strength));
  }
  return merged;
}

/**
 * Above this share of a voice's speech coming before its own introduction, the
 * label is not one person. "Mostly" is the plain reading of the rule and the
 * measurements are nowhere near it: on the recording this was written for,
 * Boris introduces himself at 19 s with 0% of his voice's speech behind him and
 * Vova at 29 s with 0%, against 93% for the voice that answered "what's your
 * name" at 38 minutes — 154 of its 165 seconds were somebody else, already
 * talking half an hour before the person it would be named after arrived.
 * Two groups that far apart mean the threshold is not fitted to them.
 */
const MOSTLY_SPOKE_BEFORE = 0.5;

/**
 * How much of a voice was already talking before it introduced itself.
 *
 * Somebody introducing themselves has just met the room, so the voice carrying
 * the introduction should be mostly speech from after it. When it is not, one
 * diarization label is holding two people and the name belongs to only part of
 * it — and naming the whole label files the other person's facts and promises
 * under a name that is not theirs, which is worse than leaving the voice
 * unnamed because nobody is prompted to notice.
 *
 * This is a guard against bad input, not a repair of it. The defect is upstream
 * in `server/audio`, where diarization produced the impure label; nothing here
 * can split one label into two, it can only decline to put a name on it.
 */
function speechShareBeforeIntroduction(claim: Claim, turns: NamingTurn[]): number | undefined {
  if (claim.target === undefined) return undefined;
  const startOf = new Map(turns.map((turn) => [turn.id, turn.start_ms]));
  const introductions = claim.mentions
    .filter((mention) => FIRST_PERSON_FRAMES.has(mention.frame))
    .map((mention) => startOf.get(mention.turn_id))
    .filter((at): at is number => at !== undefined);
  if (introductions.length === 0) return undefined;
  // The earliest moment the voice could have introduced itself, which counts
  // the most speech as coming after it and so is the reading least likely to
  // suppress a name that is really fine.
  const introducedAt = Math.min(...introductions);

  let total = 0;
  let before = 0;
  for (const turn of turns) {
    if (turn.speaker !== claim.target) continue;
    const ms = Math.max(turn.end_ms - turn.start_ms, 0);
    total += ms;
    if (turn.end_ms <= introducedAt) before += ms;
  }
  return total === 0 ? undefined : before / total;
}

function suppression(claim: Claim, context: NamingContext): { reason: SuppressionReason; detail: string } | undefined {
  const name = claim.name.toLowerCase();
  if (context.owner_name !== undefined && context.owner_name.toLowerCase() === name) {
    return { reason: 'owner_name', detail: 'that is the owner\'s own name' };
  }
  if (claim.target === undefined) {
    return { reason: 'no_addressee', detail: 'the name is not attached to any voice in the room' };
  }
  if (context.owner_speaker !== undefined && claim.target === context.owner_speaker) {
    return { reason: 'target_is_owner', detail: 'that voice is the owner, who is already known' };
  }

  const alreadyNamed = context.named_speakers?.[claim.target];
  if (alreadyNamed !== undefined) {
    if (alreadyNamed.toLowerCase() === name) {
      return { reason: 'voice_already_has_this_name', detail: `that voice is already ${alreadyNamed}` };
    }
    return { reason: 'voice_already_named_differently', detail: `that voice is already named ${alreadyNamed}` };
  }
  for (const [speaker, assigned] of Object.entries(context.named_speakers ?? {})) {
    if (assigned.toLowerCase() === name && speaker !== claim.target) {
      return { reason: 'name_already_on_another_voice', detail: `${assigned} is already a different voice here` };
    }
  }

  const participant = context.known_participants?.find((known) => known.name.toLowerCase() === name);
  if (participant !== undefined && participant.speaker !== claim.target) {
    return {
      reason: 'name_belongs_to_known_participant',
      detail: `${participant.name} is already in this conversation, so this is somebody else`,
    };
  }

  const spokeBefore = speechShareBeforeIntroduction(claim, context.turns);
  if (spokeBefore !== undefined && spokeBefore > MOSTLY_SPOKE_BEFORE) {
    return {
      reason: 'voice_speaks_mostly_before_introduction',
      detail:
        `${Math.round(spokeBefore * 100)}% of that voice was already talking before this introduction, ` +
        'so the voice is more than one person and the name would fit only part of it',
    };
  }
  return undefined;
}

function toEvent(claim: Claim, context: NamingContext): NameSuggestionEvent {
  const best = claim.mentions.reduce((a, b) => (b.strength > a.strength ? b : a));
  const event: NameSuggestionEvent = {
    type: 'name_suggestion',
    conversation_id: context.conversation_id,
    name: claim.name,
    confidence: Math.round(claim.confidence * 100) / 100,
    evidence: best.evidence,
    evidence_utterance_id: best.turn_id,
    kind: best.kind,
  };
  if (claim.target !== undefined) {
    event.session_speaker = claim.target;
    const personId = context.person_by_speaker?.[claim.target];
    if (personId !== undefined) event.person_id = personId;
  }
  return event;
}

export function scoreMentions(mentions: NameMention[], context: NamingContext): NamingResult {
  const canonical = anchorEchoes(
    canonicalizeNames(mentions.filter((mention) => mention.strength > 0)),
    context.turns,
  );
  const claims = applyContradictions(mergeVariants(buildClaims(canonical)), canonical);

  const suggestions: NameSuggestionEvent[] = [];
  const suppressed: SuppressedSuggestion[] = [];

  for (const claim of claims.sort((a, b) => b.confidence - a.confidence)) {
    const best = claim.mentions.reduce((a, b) => (b.strength > a.strength ? b : a));
    const blocked = suppression(claim, context);
    const reason: { reason: SuppressionReason; detail: string } | undefined =
      blocked ??
      (claim.confidence < NAME_SUGGESTION_MIN_CONFIDENCE
        ? { reason: 'below_threshold', detail: 'not enough corroboration to be worth asking about' }
        : undefined);

    if (reason !== undefined) {
      suppressed.push({
        name: claim.name,
        reason: reason.reason,
        detail: reason.detail,
        speaker: claim.target,
        confidence: Math.round(claim.confidence * 100) / 100,
        kind: best.kind,
        evidence: best.evidence,
      });
      continue;
    }
    suggestions.push(toEvent(claim, context));
  }

  return { suggestions, suppressed, mentions: canonical };
}

/** Rule-based pass over a whole conversation. Pure, synchronous, no network. */
export function suggestNames(context: NamingContext): NamingResult {
  const raw = extractRawMentions(tokenizeTurns(context.turns));
  return scoreMentions(attributeMentions(context.turns, raw), context);
}

export function ruleMentions(context: NamingContext): NameMention[] {
  return attributeMentions(context.turns, extractRawMentions(tokenizeTurns(context.turns)));
}
