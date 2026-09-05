import type {
  EnrollVoiceRequest,
  EnrollVoiceResponse,
  FaceClaim,
  Faceprint,
  Fact,
  Id,
  IdentityConfidence,
  IdentityConflictEvent,
  IdentitySource,
  MergePeopleRequest,
  NamePersonRequest,
  Person,
  PromiseMemory,
  ServerDependencies,
  Utterance,
  Voiceprint,
} from '../../shared/contracts';
import {
  ATTRIBUTION_MARGIN,
  ATTRIBUTION_THRESHOLD,
  CONFIRMED_SPEECH_MS,
  CROSS_SESSION_SPEECH_MS,
  EMBED_MIN_MS,
  MAX_VOICEPRINTS_PER_PERSON,
  OWNER_AUTH_THRESHOLD,
  OWNER_ID,
  PROVISIONAL_SPEECH_MS,
  VOICEPRINT_DIMS,
} from '../../shared/contracts';
import {
  assignClusters,
  centered,
  confidenceFor,
  cosine,
  decide,
  scorePeople,
  selectEvictions,
  type ClusterQuery,
  type Decision,
} from './matcher';
import { mergeCandidates, type DuplicateCandidate, type DuplicateOptions } from './duplicates';
import { fuse, type FusedDecision } from './fusion';

type Filter = Record<string, unknown>;
type Update<T> = { $set: Partial<T> };
type PipelineStage = Record<string, unknown>;

export interface IdentityCollection<T> {
  insertOne(document: T): Promise<unknown>;
  find(filter?: Filter): { toArray(): Promise<T[]> };
  findOne(filter: Filter): Promise<T | null>;
  updateOne(filter: Filter, update: Update<T>): Promise<unknown>;
  updateMany(filter: Filter, update: Update<T>): Promise<unknown>;
  deleteMany(filter: Filter): Promise<unknown>;
  distinct(key: string, filter: Filter): Promise<unknown[]>;
}

/**
 * Matching is exact cosine computed in this process, so a voiceprint store
 * needs nothing an ordinary collection cannot do. Atlas `$vectorSearch` used to
 * be required here and was the single reason identification could not run
 * without a reachable Atlas cluster and an applied vector index; at tens to low
 * hundreds of prints, approximate nearest neighbour was also strictly worse
 * than the exact answer.
 */
export type VoiceprintCollection = IdentityCollection<Voiceprint>;

/**
 * The name given to a voice we can tell apart but cannot put a name to. The app
 * treats anything matching /^(unknown|unnamed|speaker)/i as unnamed and offers
 * tap-to-name against it.
 */
export const UNNAMED_PERSON_NAME = 'Unnamed voice';

export interface IdentityServiceOptions {
  collections: {
    people: IdentityCollection<Person>;
    voiceprints: VoiceprintCollection;
    utterances: IdentityCollection<Utterance>;
    facts: IdentityCollection<Fact>;
    promises: IdentityCollection<PromiseMemory>;
    /**
     * Optional because faces are a second capture surface, not a requirement.
     * A deployment with no camera never has this collection, and identity works
     * exactly as it did — but a merge must re-point faceprints where they exist,
     * or the survivor loses the face that recognised them.
     */
    faceprints?: IdentityCollection<Faceprint>;
  };
  bus: ServerDependencies['bus'];
  now?: () => Date;
}

export interface AttributionInput {
  embedding: number[];
  duration_ms: number;
  conversation_id: string;
  utterance_ids: string[];
  /** Mean embedding of this session. Subtracted before comparing; see matcher.ts. */
  session_mean?: number[] | null;
  /** The session cluster this pooled speech came from, when the caller tracks one. */
  session_speaker?: string;
  /**
   * What the camera saw over the same stretch of speech. Weighed against the
   * voice rather than trusted over it; see fusion.ts.
   */
  face_claims?: FaceClaim[];
  /**
   * Whether an unrecognised voice may become a new person. Default true.
   *
   * False on a pavement: 'street' capture records the owner and whoever is
   * demonstrably talking to them, and minting a person for every passer-by the
   * mic caught would fill the people list with strangers who are then kept
   * forever, which is the opposite of what that mode is for.
   */
  allow_mint?: boolean;
  /** Extent of the speech this input pooled, for the conflict event. */
  start_ms?: number;
  end_ms?: number;
}

export type AttributionResult =
  | { status: 'pending'; reason: 'below_floor' | 'gathering' | 'no_match' | 'ambiguous' }
  | {
      status: 'matched';
      person_id: string;
      /**
       * Absent when a face carried the claim on its own and the speech was too
       * thin to harvest a print from: there is no voiceprint behind it, and
       * naming one that does not exist is worse than saying nothing.
       */
      voiceprint_id?: string;
      confidence: number;
      identity_confidence: IdentityConfidence;
      source?: IdentitySource;
    }
  | {
      status: 'created';
      person_id: string;
      voiceprint_id: string;
      identity_confidence: IdentityConfidence;
    };

export interface SessionClusterInput extends Omit<AttributionInput, 'conversation_id'> {
  session_speaker: string;
}

export interface FaceAttributionInput {
  conversation_id: string;
  person_id: Id;
  utterance_ids: string[];
  face_score: number;
  track_id: Id;
}

/** The pooled speech behind a name the user just typed, so it reinforces. */
export interface NameEnrollment {
  embedding: number[];
  session_mean?: number[] | null;
  duration_ms: number;
  conversation_id?: string;
  utterance_id?: string;
}

export interface IdentityService {
  attributeSpeaker(input: AttributionInput): Promise<AttributionResult>;
  /**
   * Attribute every cluster of one session at once, one person per cluster.
   * Preferred over repeated attributeSpeaker calls when the caller has the
   * whole session in hand, because the assignment is then globally greedy
   * rather than greedy in arrival order.
   */
  attributeSession(input: {
    conversation_id: string;
    clusters: SessionClusterInput[];
  }): Promise<Record<string, AttributionResult>>;
  /**
   * Name a cluster from the face alone.
   *
   * For speech under the embedding floor — a "yeah" and a laugh — which the
   * voice path cannot and should not touch, while the camera has been looking
   * at the person saying it for several seconds. No print is written and no
   * voice evidence is claimed; this only puts a name on lines that would
   * otherwise stay anonymous forever.
   */
  attributeByFace(input: FaceAttributionInput): Promise<AttributionResult>;
  isOwnerVoice(
    embedding: number[],
    sessionMean?: number[] | null,
  ): Promise<{ authorized: boolean; confidence: number }>;
  enroll(request: EnrollVoiceRequest & { session_mean?: number[] }): Promise<EnrollVoiceResponse>;
  namePerson(
    personId: string,
    request: NamePersonRequest,
    enrollment?: NameEnrollment,
  ): Promise<Person>;
  mergePeople(request: MergePeopleRequest): Promise<Person>;
  /**
   * People who look like the same voice under two records. Read-only on
   * purpose: see server/identity/duplicates.ts for why this proposes and never
   * acts.
   */
  duplicateCandidates(options?: DuplicateOptions): Promise<DuplicateCandidate[]>;
}

/**
 * Kept for `server/index.ts`, which still runs its own owner-confidence lookup
 * against Atlas. Nothing in this service uses either any more.
 *
 * @deprecated Score with `matcher.ts` instead; Atlas is not reachable from the
 * venue network and exact cosine over a few hundred prints is both cheaper and
 * more accurate.
 */
export function voiceprintSearchPipeline(embedding: number[], personId?: string): PipelineStage[] {
  return [
    {
      $vectorSearch: {
        index: 'voiceprints_vector',
        path: 'embedding',
        queryVector: embedding,
        filter: {
          owner_id: OWNER_ID,
          ...(personId ? { person_id: personId } : {}),
        },
        numCandidates: 60,
        limit: 3,
      },
    },
    {
      $project: {
        _id: 1,
        owner_id: 1,
        person_id: 1,
        embedding: 1,
        duration_ms: 1,
        source_utterance_id: 1,
        created_at: 1,
        score: { $meta: 'vectorSearchScore' },
      },
    },
  ];
}

/** Atlas cosine scores are normalized to [0, 1]; contracts use raw cosine. */
export function rawCosine(atlasScore: number): number {
  const raw = Math.max(-1, Math.min(1, atlasScore * 2 - 1));
  return Math.round(raw * 1e12) / 1e12;
}

/**
 * The face claim worth weighing against the voice: the most confident one, and
 * among equals the best-scoring. More than one confirmed face over the same
 * speech is two people in frame while one of them talks, and the strongest
 * claim is the honest single answer to give the fusion.
 */
export function strongestClaim(claims?: readonly FaceClaim[]): FaceClaim | undefined {
  const rank = (claim: FaceClaim): number =>
    claim.confidence === 'confirmed' ? 2 : claim.confidence === 'provisional' ? 1 : 0;
  return (claims ?? [])
    .filter((claim) => claim.person_id !== undefined)
    .reduce<FaceClaim | undefined>((best, claim) => {
      if (!best) return claim;
      if (rank(claim) !== rank(best)) return rank(claim) > rank(best) ? claim : best;
      return claim.score > best.score ? claim : best;
    }, undefined);
}

function hasConfirmedFace(claims?: readonly FaceClaim[]): boolean {
  return strongestClaim(claims)?.confidence === 'confirmed';
}

/** One person per session cluster: who a conversation has already spoken for. */
interface Claim {
  person_id: Id;
  utterance_ids: Set<string>;
  reinforced: boolean;
}

export function createIdentityService(options: IdentityServiceOptions): IdentityService {
  const { collections, bus } = options;
  const timestamp = () => (options.now?.() ?? new Date()).toISOString();
  const claimsByConversation = new Map<string, Claim[]>();
  /**
   * Face-versus-voice disagreements this process has seen, keyed by the pair.
   *
   * In memory on purpose. A conflict is a question, not a record: it is worth
   * surfacing while the app is up so the owner can answer it, and it is not
   * worth a collection that would then need pruning when he merges the pair.
   */
  const conflicts = new Map<string, IdentityConflictEvent>();

  const envNumber = (name: string, fallback: number): number => {
    const raw = process.env[name];
    const parsed = raw === undefined ? Number.NaN : Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  /**
   * Every print whose person still exists. Orphans outlive their person after a
   * merge or a delete, and one of them winning a search used to take
   * attribution down for that speaker for a whole conversation.
   */
  const livePrints = async (): Promise<{ prints: Voiceprint[]; people: Map<Id, Person> }> => {
    const prints = await collections.voiceprints.find({ owner_id: OWNER_ID }).toArray();
    const people = await collections.people.find({ owner_id: OWNER_ID }).toArray();
    const byId = new Map(people.map((person) => [person._id, person]));
    return { prints: prints.filter((print) => byId.has(print.person_id)), people: byId };
  };

  const claimsFor = (conversationId: string): Claim[] => {
    const claims = claimsByConversation.get(conversationId) ?? [];
    claimsByConversation.set(conversationId, claims);
    return claims;
  };

  /** A cluster may re-take a person it already holds; nobody else may. */
  const claimOwnedBy = (claims: Claim[], utteranceIds: string[]): Claim | undefined =>
    claims.find((claim) => utteranceIds.some((id) => claim.utterance_ids.has(id)));

  const takenBySomeoneElse = (claims: Claim[], utteranceIds: string[]): Id[] =>
    claims
      .filter((claim) => !utteranceIds.some((id) => claim.utterance_ids.has(id)))
      .map((claim) => claim.person_id);

  const recordClaim = (conversationId: string, personId: Id, utteranceIds: string[]): Claim => {
    const claims = claimsFor(conversationId);
    const existing = claimOwnedBy(claims, utteranceIds);
    if (existing) {
      existing.person_id = personId;
      for (const id of utteranceIds) existing.utterance_ids.add(id);
      return existing;
    }
    const claim: Claim = { person_id: personId, utterance_ids: new Set(utteranceIds), reinforced: false };
    claims.push(claim);
    return claim;
  };

  const attachUtterances = async (
    utteranceIds: string[],
    personId: Id,
    voiceprintId?: Id,
  ): Promise<void> => {
    if (utteranceIds.length === 0) return;
    await collections.utterances.updateMany(
      { _id: { $in: utteranceIds }, owner_id: OWNER_ID },
      {
        $set: {
          person_id: personId,
          // Left alone when a face carried the claim: there is no print behind
          // it, and blanking the one the line already had would lose evidence.
          ...(voiceprintId ? { voiceprint_id: voiceprintId } : {}),
          updated_at: timestamp(),
        },
      },
    );
  };

  const findPerson = async (personId: Id): Promise<Person | null> =>
    collections.people.findOne({ _id: personId, owner_id: OWNER_ID });

  const insertPrint = async (print: Voiceprint): Promise<void> => {
    await collections.voiceprints.insertOne(print);
    const existing = await collections.voiceprints
      .find({ owner_id: OWNER_ID, person_id: print.person_id })
      .toArray();
    /**
     * The print just inserted is never a candidate for its own eviction, so the
     * rest compete for one fewer slot.
     *
     * Two reasons. Callers are handed this id and file utterances under it, and
     * selectEvictions now drops the THINNEST print rather than the oldest — so
     * without this, storing a print for somebody whose existing prints all hold
     * more speech would delete it again inside the same call and leave every
     * utterance in the session pointing at a voiceprint that does not exist.
     * The second reason is that recency is not worthless even though duration
     * decides quality: the newest print is the only one captured in the room the
     * speaker is in now, which is the channel diversity
     * MAX_VOICEPRINTS_PER_PERSON exists to accumulate.
     */
    const others = existing.filter((candidate) => candidate._id !== print._id);
    const doomed = selectEvictions(others, MAX_VOICEPRINTS_PER_PERSON - 1);
    if (doomed.length > 0) {
      await collections.voiceprints.deleteMany({ _id: { $in: doomed }, owner_id: OWNER_ID });
    }
  };

  /**
   * Add this session's pooled speech to a person's print set, if it is worth
   * writing down. This is how somebody first met in a dorm is still recognised
   * in a lecture hall.
   *
   * Below CROSS_SESSION_SPEECH_MS a print recognises a thin cluster in another
   * room only 67-82% of the time, and the miss mints a duplicate that splits
   * one person's facts across two records forever. So thin pooled speech does
   * not earn a print — UNLESS the person has none at all, and that exception is
   * not a hedge. The measured failure is asymmetric: a print backed by 20s
   * still recognises a 60s cluster with 1.7% miss, so a thin print is worth
   * having for the next long conversation, whereas no print at all misses 100%
   * of the time and guarantees the duplicate it was meant to avoid. Something
   * beats nothing; thin-on-top-of-good is what beats nothing by less than the
   * cap it consumes.
   *
   * Adding a thin print cannot cost precision, only recall: a person scores as
   * the MAX over their prints, and across every pool size measured no two
   * different people reached ATTRIBUTION_THRESHOLD (impostor max 0.627). The
   * only harm a thin print can do is occupy a slot under
   * MAX_VOICEPRINTS_PER_PERSON, and selectEvictions now drops the thinnest
   * first for exactly that reason.
   */
  const storePrint = async (personId: Id, input: AttributionInput, createdAt: string): Promise<Id> => {
    const print: Voiceprint = {
      _id: crypto.randomUUID(),
      owner_id: OWNER_ID,
      person_id: personId,
      embedding: input.embedding,
      ...(input.session_mean ? { session_mean: input.session_mean } : {}),
      duration_ms: input.duration_ms,
      source_conversation_id: input.conversation_id,
      created_at: createdAt,
    };
    await insertPrint(print);
    return print._id;
  };

  const reinforce = async (
    personId: Id,
    input: AttributionInput,
    createdAt: string,
  ): Promise<Id | undefined> => {
    if (input.duration_ms < envNumber('CROSS_SESSION_SPEECH_MS', CROSS_SESSION_SPEECH_MS)) {
      const existing = await collections.voiceprints.findOne({
        owner_id: OWNER_ID,
        person_id: personId,
      });
      if (existing) return undefined;
    }
    return storePrint(personId, input, createdAt);
  };

  const emitIdentity = (
    conversationId: string,
    person: Person,
    utteranceIds: string[],
    confidence: IdentityConfidence,
    evidence: {
      voiceprintId?: Id;
      score?: number;
      source?: IdentitySource;
      faceScore?: number;
      faceTrackId?: Id;
    } = {},
  ): void => {
    bus.emit({
      type: 'identity',
      conversation_id: conversationId,
      person_id: person._id,
      ...(evidence.voiceprintId ? { voiceprint_id: evidence.voiceprintId } : {}),
      name: person.name,
      utterance_ids: utteranceIds,
      confidence,
      ...(evidence.score === undefined ? {} : { score: evidence.score }),
      ...(evidence.source ? { source: evidence.source } : {}),
      ...(evidence.faceScore === undefined ? {} : { face_score: evidence.faceScore }),
      ...(evidence.faceTrackId ? { face_track_id: evidence.faceTrackId } : {}),
    });
  };

  /**
   * Write a print because a face vouched for the speaker.
   *
   * The cross-session floor is deliberately bypassed. That floor exists because
   * thin pooled speech recognises the same person in another room only two
   * thirds of the time and the miss mints a duplicate — but the duplicate is
   * exactly what cannot happen here, because the person is already known from
   * the face. What is left is a thin print that may be imperfect, which
   * `taught_by: 'face'` is here to make findable. The three-second embedding
   * floor still holds: below it there is no print worth writing at all.
   */
  const harvestVoiceprint = async (personId: Id, input: AttributionInput): Promise<Id | undefined> => {
    if (input.duration_ms < envNumber('EMBED_MIN_MS', EMBED_MIN_MS)) return undefined;
    const print: Voiceprint = {
      _id: crypto.randomUUID(),
      owner_id: OWNER_ID,
      person_id: personId,
      embedding: input.embedding,
      ...(input.session_mean ? { session_mean: input.session_mean } : {}),
      duration_ms: input.duration_ms,
      source_conversation_id: input.conversation_id,
      taught_by: 'face',
      created_at: timestamp(),
    };
    await insertPrint(print);
    return print._id;
  };

  /**
   * A person the fused decision named, turned into records and events.
   *
   * Nothing is written to an utterance below `confirmed`: a provisional claim
   * is shown live as a guess and must not become the filed answer, because
   * facts and promises are read back off utterance.person_id.
   */
  const applyMatchedPerson = async (
    conversationId: string,
    input: AttributionInput,
    fused: Extract<FusedDecision, { status: 'matched' }>,
    people: Map<Id, Person>,
  ): Promise<AttributionResult> => {
    const person = people.get(fused.person_id) ?? (await findPerson(fused.person_id));
    if (!person) return { status: 'pending', reason: 'no_match' };
    const claim = recordClaim(conversationId, person._id, input.utterance_ids);
    let voiceprintId = fused.voiceprint_id;
    if (fused.confidence === 'confirmed') {
      if (!claim.reinforced) {
        // Thin pooled speech does not earn a new print. The utterances still
        // file under the print that matched, so nothing downstream loses its
        // voiceprint_id when reinforcement declines.
        if (fused.reinforce) voiceprintId = (await reinforce(person._id, input, timestamp())) ?? voiceprintId;
        else if (fused.harvest_voice) voiceprintId = (await harvestVoiceprint(person._id, input)) ?? voiceprintId;
        claim.reinforced = true;
      }
      await attachUtterances(input.utterance_ids, person._id, voiceprintId);
    }
    emitIdentity(conversationId, person, input.utterance_ids, fused.confidence, {
      voiceprintId,
      score: fused.voice_score,
      source: fused.source,
      faceScore: fused.face_score,
      faceTrackId: fused.face_track_id,
    });
    return {
      status: 'matched',
      person_id: person._id,
      ...(voiceprintId ? { voiceprint_id: voiceprintId } : {}),
      confidence: fused.voice_score,
      identity_confidence: fused.confidence,
      source: fused.source,
    };
  };

  /**
   * Nobody we know. Minting a person is only worth it once there is enough
   * pooled speech for the print to recognise them again — below that the same
   * stranger becomes a fresh "Unknown" in every conversation, which is how the
   * people list filled with ghosts.
   */
  const applyMintedPerson = async (
    conversationId: string,
    input: AttributionInput,
    people: Map<Id, Person>,
  ): Promise<AttributionResult> => {
    const now = timestamp();
    const person: Person = {
      _id: crypto.randomUUID(),
      owner_id: OWNER_ID,
      name: UNNAMED_PERSON_NAME,
      // Said in the record rather than inferred from the name, so a person
      // actually called "Unnamed voice" is never treated as waiting for a name.
      is_unnamed: true,
      created_at: now,
      updated_at: now,
    };
    await collections.people.insertOne(person);
    people.set(person._id, person);
    const voiceprintId = await storePrint(person._id, input, now);
    const claim = recordClaim(conversationId, person._id, input.utterance_ids);
    claim.reinforced = true;
    await attachUtterances(input.utterance_ids, person._id, voiceprintId);
    emitIdentity(conversationId, person, input.utterance_ids, 'confirmed', {
      voiceprintId,
      source: 'voice',
    });
    return { status: 'created', person_id: person._id, voiceprint_id: voiceprintId, identity_confidence: 'confirmed' };
  };

  /**
   * The face and the voice both named somebody, confidently, and they are not
   * the same person. Nothing is written and nobody is named: the pair goes to
   * the owner as a merge candidate and waits there.
   */
  const applyConflict = (
    conversationId: string,
    input: AttributionInput,
    fused: Extract<FusedDecision, { status: 'conflict' }>,
  ): AttributionResult => {
    const event: IdentityConflictEvent = {
      type: 'identity_conflict',
      conversation_id: conversationId,
      face_person_id: fused.face_person_id,
      voice_person_id: fused.voice_person_id,
      utterance_ids: input.utterance_ids,
      face_score: fused.face_score,
      voice_score: fused.voice_score,
      start_ms: input.start_ms ?? 0,
      end_ms: input.end_ms ?? input.duration_ms,
    };
    conflicts.set(`${fused.face_person_id}:${fused.voice_person_id}`, event);
    bus.emit(event);
    return { status: 'pending', reason: 'ambiguous' };
  };

  const applyPendingResult = (
    reason: 'no_match' | 'ambiguous',
  ): AttributionResult => ({ status: 'pending', reason });

  /**
   * One cluster's evidence, dispatched. The rules themselves are in fusion.ts,
   * which is pure; everything here is the writing down.
   */
  const applyDecision = async (
    conversationId: string,
    input: AttributionInput,
    decision: Decision,
    people: Map<Id, Person>,
  ): Promise<AttributionResult> => {
    const tier = confidenceFor(input.duration_ms);
    const fused = fuse(decision, tier, strongestClaim(input.face_claims));
    if (fused.status === 'conflict') return applyConflict(conversationId, input, fused);
    if (fused.status === 'matched') return applyMatchedPerson(conversationId, input, fused, people);
    if (fused.reason === 'ambiguous') return applyPendingResult('ambiguous');
    if (tier !== 'confirmed' || input.allow_mint === false) return applyPendingResult('no_match');
    return applyMintedPerson(conversationId, input, people);
  };

  /**
   * A confirmed face lets a cluster be asked about before the voice alone would
   * be worth asking about: the two identifiers are independent, so the speech
   * only has to be long enough to embed, not long enough to name somebody by.
   */
  const gate = (input: { duration_ms: number; face_claims?: FaceClaim[] }): AttributionResult | null => {
    if (input.duration_ms < envNumber('EMBED_MIN_MS', EMBED_MIN_MS)) {
      return { status: 'pending', reason: 'below_floor' };
    }
    if (hasConfirmedFace(input.face_claims)) return null;
    if (input.duration_ms < envNumber('PROVISIONAL_SPEECH_MS', PROVISIONAL_SPEECH_MS)) {
      return { status: 'pending', reason: 'gathering' };
    }
    return null;
  };

  /**
   * Face-versus-voice disagreements, as merge questions.
   *
   * The score carried is the face cosine — the evidence that raised the pair.
   * A conflict already proposed by voice resemblance is left to that candidate
   * rather than listed twice.
   */
  const conflictCandidates = (
    people: Map<Id, Person>,
    proposed: readonly DuplicateCandidate[],
  ): DuplicateCandidate[] => {
    const seen = new Set(
      proposed.map((candidate) => [...candidate.sides.map((side) => side.person_id)].sort().join(':')),
    );
    const candidates: DuplicateCandidate[] = [];
    for (const conflict of conflicts.values()) {
      const face = people.get(conflict.face_person_id);
      const voice = people.get(conflict.voice_person_id);
      if (!face || !voice) continue;
      const key = [face._id, voice._id].sort().join(':');
      if (seen.has(key)) continue;
      seen.add(key);
      const [first, second] = face.created_at <= voice.created_at ? [face, voice] : [voice, face];
      candidates.push({
        score: conflict.face_score,
        sides: [
          { person_id: first._id, name: first.name },
          { person_id: second._id, name: second.name },
        ],
        reason: 'face_voice_conflict',
      });
    }
    return candidates;
  };

  /**
   * The face to show for a person, after their faceprints have moved.
   *
   * `Person.avatar_thumbnail` is denormalised so every list screen can render a
   * face off the one call it already makes, which means a merge has to refresh
   * it — otherwise the survivor keeps an avatar cropped from a record that no
   * longer exists, or none at all while the person they absorbed had one.
   */
  const bestThumbnail = async (personId: Id): Promise<string | undefined> => {
    const prints = await collections.faceprints?.find({ owner_id: OWNER_ID, person_id: personId }).toArray();
    return (prints ?? [])
      .filter((print) => print.thumbnail !== undefined)
      .sort((left, right) => right.quality - left.quality)[0]?.thumbnail;
  };

  const thresholds = () => ({
    threshold: envNumber('ATTRIBUTION_THRESHOLD', ATTRIBUTION_THRESHOLD),
    margin: envNumber('ATTRIBUTION_MARGIN', ATTRIBUTION_MARGIN),
  });

  return {
    async attributeSpeaker(input) {
      const blocked = gate(input);
      if (blocked) return blocked;

      const { prints, people } = await livePrints();
      const claims = claimsFor(input.conversation_id);
      const decision = decide(scorePeople(input.embedding, input.session_mean, prints), {
        ...thresholds(),
        taken: takenBySomeoneElse(claims, input.utterance_ids),
      });
      return applyDecision(input.conversation_id, input, decision, people);
    },

    async attributeSession({ conversation_id, clusters }) {
      const results: Record<string, AttributionResult> = {};
      const eligible: SessionClusterInput[] = [];
      for (const cluster of clusters) {
        const blocked = gate(cluster);
        if (blocked) results[cluster.session_speaker] = blocked;
        else eligible.push(cluster);
      }
      if (eligible.length === 0) return results;

      const { prints, people } = await livePrints();
      const claims = claimsFor(conversation_id);
      const queries: ClusterQuery[] = eligible.map((cluster) => ({
        key: cluster.session_speaker,
        embedding: cluster.embedding,
        session_mean: cluster.session_mean,
        duration_ms: cluster.duration_ms,
      }));
      const decisions = assignClusters(queries, prints, {
        ...thresholds(),
        taken: claims.map((claim) => claim.person_id),
      });
      for (const cluster of eligible) {
        const decision = decisions.get(cluster.session_speaker) ?? { status: 'no_match' as const, score: 0 };
        results[cluster.session_speaker] = await applyDecision(
          conversation_id,
          { ...cluster, conversation_id },
          decision,
          people,
        );
      }
      return results;
    },

    async attributeByFace({ conversation_id, person_id, utterance_ids, face_score, track_id }) {
      const person = await findPerson(person_id);
      if (!person) return { status: 'pending', reason: 'no_match' };
      recordClaim(conversation_id, person._id, utterance_ids);
      await attachUtterances(utterance_ids, person._id);
      emitIdentity(conversation_id, person, utterance_ids, 'confirmed', {
        source: 'face',
        faceScore: face_score,
        faceTrackId: track_id,
      });
      return {
        status: 'matched',
        person_id: person._id,
        confidence: face_score,
        identity_confidence: 'confirmed',
        source: 'face',
      };
    },

    async isOwnerVoice(embedding, sessionMean) {
      const owner = await collections.people.findOne({ owner_id: OWNER_ID, is_owner: true });
      if (!owner) return { authorized: false, confidence: 0 };

      const { prints } = await livePrints();
      const scores = scorePeople(embedding, sessionMean, prints);
      const decision = decide(scores, {
        threshold: envNumber('OWNER_AUTH_THRESHOLD', OWNER_AUTH_THRESHOLD),
        margin: ATTRIBUTION_MARGIN,
      });
      const ownerScore = scores.find((score) => score.person_id === owner._id)?.score ?? 0;
      const authorized = decision.status === 'matched' && decision.person_id === owner._id;
      return { authorized, confidence: ownerScore };
    },

    async enroll(request) {
      if (!request.embedding || request.embedding.length !== VOICEPRINT_DIMS) {
        throw new Error(`Voiceprint embeddings must have ${VOICEPRINT_DIMS} dimensions`);
      }

      let person: Person;
      if (request.person_id) {
        const existing = await collections.people.findOne({
          _id: request.person_id,
          owner_id: OWNER_ID,
        });
        if (!existing) throw new Error(`Unknown person: ${request.person_id}`);
        person = existing;
      } else {
        const now = timestamp();
        person = {
          _id: crypto.randomUUID(),
          owner_id: OWNER_ID,
          name: request.name ?? UNNAMED_PERSON_NAME,
          created_at: now,
          updated_at: now,
        };
        await collections.people.insertOne(person);
      }

      const voiceprint: Voiceprint = {
        _id: crypto.randomUUID(),
        owner_id: OWNER_ID,
        person_id: person._id,
        embedding: request.embedding,
        ...(request.session_mean ? { session_mean: request.session_mean } : {}),
        duration_ms: request.duration_ms,
        ...(request.utterance_id ? { source_utterance_id: request.utterance_id } : {}),
        created_at: timestamp(),
        enrolled: true,
      };
      await insertPrint(voiceprint);
      const { embedding: _embedding, ...publicVoiceprint } = voiceprint;
      return { person, voiceprint: publicVoiceprint };
    },

    /**
     * The single most important path in the product: the user taps an unnamed
     * voice and types a name. That is the strongest identity signal there is,
     * so the prints behind it become permanent (never evicted) and the pooled
     * pooled speech from this session is stored as a print, which is what makes
     * the next session recognise them.
     */
    async namePerson(personId, request, enrollment) {
      const person = await collections.people.findOne({ _id: personId, owner_id: OWNER_ID });
      if (!person) throw new Error(`Unknown person: ${personId}`);

      const changes: Partial<Person> = {
        name: request.name,
        updated_at: timestamp(),
        ...(request.relationship !== undefined ? { relationship: request.relationship } : {}),
      };
      await collections.people.updateOne({ _id: personId, owner_id: OWNER_ID }, { $set: changes });
      const updatedPerson = { ...person, ...changes };

      // Deliberately NOT marking this person's existing prints as enrolled.
      //
      // They were captured automatically; putting a name to the voice does not
      // make them any more hand-checked than they were a moment ago. Blessing
      // them all was quietly fatal to cross-session recognition, which is the
      // product's whole promise: enrolled prints are never evicted, so a named
      // person sat permanently at MAX_VOICEPRINTS_PER_PERSON and every later
      // session inserted a print that the very next eviction deleted. Somebody
      // met in a dorm could never learn how they sound in a lecture hall — the
      // exact case the cap exists to serve.
      //
      // Only prints the user actually created are enrolled: an explicit
      // enrollment, or the pooled speech handed to this call below.
      if (enrollment) {
        await insertPrint({
          _id: crypto.randomUUID(),
          owner_id: OWNER_ID,
          person_id: personId,
          embedding: enrollment.embedding,
          ...(enrollment.session_mean ? { session_mean: enrollment.session_mean } : {}),
          duration_ms: enrollment.duration_ms,
          ...(enrollment.utterance_id ? { source_utterance_id: enrollment.utterance_id } : {}),
          ...(enrollment.conversation_id ? { source_conversation_id: enrollment.conversation_id } : {}),
          created_at: timestamp(),
          enrolled: true,
        });
      }

      const utterances = await collections.utterances
        .find({ owner_id: OWNER_ID, person_id: personId })
        .toArray();
      const utterancesByConversation = new Map<string, string[]>();
      for (const utterance of utterances) {
        const utteranceIds = utterancesByConversation.get(utterance.conversation_id) ?? [];
        utteranceIds.push(utterance._id);
        utterancesByConversation.set(utterance.conversation_id, utteranceIds);
      }
      for (const [conversationId, utteranceIds] of utterancesByConversation) {
        emitIdentity(conversationId, updatedPerson, utteranceIds, 'confirmed');
      }
      return updatedPerson;
    },

    async duplicateCandidates(options) {
      const { prints, people } = await livePrints();
      const byVoice = mergeCandidates([...people.values()], prints, options);
      // Conflicts first, whatever their score: a face and a voice disagreeing
      // over one breath is direct evidence about one pair, where a cosine is a
      // resemblance. The two numbers are not on the same scale, so ranking them
      // against each other would be arithmetic on nothing.
      const all = [...conflictCandidates(people, byVoice), ...byVoice];
      return options?.limit === undefined ? all : all.slice(0, options.limit);
    },

    async mergePeople(request) {
      const personIds = [...new Set(request.person_ids)];
      if (personIds.length < 2) throw new Error('At least two people are required to merge');

      const people = await collections.people
        .find({ _id: { $in: personIds }, owner_id: OWNER_ID })
        .toArray();
      if (people.length !== personIds.length) throw new Error('Cannot merge unknown people');

      const survivor = people.reduce((oldest, person) =>
        person.created_at < oldest.created_at ? person : oldest,
      );
      const loserIds = personIds.filter((personId) => personId !== survivor._id);
      const affectedFilter = { owner_id: OWNER_ID, person_id: { $in: loserIds } };
      const conversationIds = (
        await collections.utterances.distinct('conversation_id', affectedFilter)
      ).filter((id): id is string => typeof id === 'string');
      const affectedUtterances = await collections.utterances.find(affectedFilter).toArray();

      await collections.voiceprints.updateMany(affectedFilter, {
        $set: { person_id: survivor._id },
      });
      await collections.faceprints?.updateMany(affectedFilter, {
        $set: { person_id: survivor._id },
      });
      await collections.utterances.updateMany(affectedFilter, {
        $set: { person_id: survivor._id, updated_at: timestamp() },
      });
      await collections.facts.updateMany(affectedFilter, { $set: { person_id: survivor._id } });
      await collections.promises.updateMany(affectedFilter, { $set: { person_id: survivor._id } });
      await collections.people.deleteMany({ _id: { $in: loserIds }, owner_id: OWNER_ID });
      const avatar = await bestThumbnail(survivor._id);
      if (avatar && avatar !== survivor.avatar_thumbnail) {
        await collections.people.updateOne(
          { _id: survivor._id, owner_id: OWNER_ID },
          { $set: { avatar_thumbnail: avatar, updated_at: timestamp() } },
        );
        survivor.avatar_thumbnail = avatar;
      }
      for (const [key, conflict] of conflicts) {
        if (loserIds.includes(conflict.face_person_id) || loserIds.includes(conflict.voice_person_id)) {
          conflicts.delete(key);
        }
      }

      for (const conversationId of conversationIds) {
        emitIdentity(
          conversationId,
          survivor,
          affectedUtterances
            .filter((utterance) => utterance.conversation_id === conversationId)
            .map((utterance) => utterance._id),
          'confirmed',
        );
      }
      return survivor;
    },
  };
}

/** Re-exported so callers scoring voices elsewhere use the one implementation. */
export { centered, cosine, scorePeople, confidenceFor };
