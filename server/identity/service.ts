import type {
  EnrollVoiceRequest,
  EnrollVoiceResponse,
  Fact,
  MergePeopleRequest,
  NamePersonRequest,
  Person,
  PromiseMemory,
  ServerDependencies,
  Utterance,
  Voiceprint,
} from '../../shared/contracts';
import { EMBED_MIN_MS, OWNER_ID, VOICEPRINT_DIMS } from '../../shared/contracts';
import { attributionThreshold, ownerAuthThreshold } from '../lib/thresholds';
import {
  DEFAULT_COHORT_SIZE,
  adaptiveSNorm,
  cohortStats,
  decideSpeaker,
} from './score-norm';

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

export interface VoiceprintCollection extends IdentityCollection<Voiceprint> {
  aggregate<TResult extends object = Voiceprint>(
    pipeline: PipelineStage[],
  ): { toArray(): Promise<TResult[]> };
}

export interface IdentityServiceOptions {
  collections: {
    people: IdentityCollection<Person>;
    voiceprints: VoiceprintCollection;
    utterances: IdentityCollection<Utterance>;
    facts: IdentityCollection<Fact>;
    promises: IdentityCollection<PromiseMemory>;
  };
  bus: ServerDependencies['bus'];
  now?: () => Date;
}

export interface IdentityService {
  attributeSpeaker(input: {
    embedding: number[];
    duration_ms: number;
    conversation_id: string;
    utterance_ids: string[];
  }): Promise<
    // `below_floor`: too little audio to embed at all.
    // `ambiguous`: enough audio, a plausible candidate, but not clear enough of
    // the runner-up to be worth the risk of merging two people. Both are
    // retried by the caller when more audio arrives.
    | { status: 'pending'; reason: 'below_floor' | 'ambiguous' }
    | { status: 'matched'; person_id: string; voiceprint_id: string; confidence: number }
    | { status: 'created'; person_id: string; voiceprint_id: string }
  >;
  isOwnerVoice(embedding: number[]): Promise<{ authorized: boolean; confidence: number }>;
  enroll(request: EnrollVoiceRequest): Promise<EnrollVoiceResponse>;
  namePerson(personId: string, request: NamePersonRequest): Promise<Person>;
  mergePeople(request: MergePeopleRequest): Promise<Person>;
}

interface VoiceprintMatch extends Voiceprint {
  score: number;
}

/** A candidate carrying the raw cosine alongside the Atlas [0,1] score. */
interface ScoredMatch extends VoiceprintMatch {
  cosine: number;
}

/**
 * How far, in deviations above cohort, the leader must beat the runner-up.
 *
 * Not fitted, and deliberately conservative — the two errors are not
 * symmetric. Set it too high and a real match is held as `pending`, which the
 * caller retries on the next chunk with more audio. Set it too low and two
 * people are merged, which is silent, permanent, and only visible later as one
 * person remembering things they never said.
 */
const DEFAULT_MARGIN_SIGMA = 0.75;

function marginSigma(): number {
  const raw = process.env.ATTRIBUTION_MARGIN_SIGMA;
  if (raw === undefined || raw === '') return DEFAULT_MARGIN_SIGMA;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    console.warn(`ATTRIBUTION_MARGIN_SIGMA="${raw}" is not a number — using ${DEFAULT_MARGIN_SIGMA}`);
    return DEFAULT_MARGIN_SIGMA;
  }
  return parsed;
}

/**
 * AS-norm each live candidate against the people it is definitely not.
 *
 * Symmetric, so both halves are computed. The test side comes free from the
 * search we already ran: every OTHER person's best score is, by construction, an
 * imposter trial for this candidate. The enrolled side costs one extra vector
 * search per candidate — the candidate's own stored voiceprint scored against
 * everybody else — and it is the half that catches a voiceprint which sits
 * close to the whole database. Bounded at two candidates, so at most two extra
 * searches per speaker cluster, not per utterance.
 *
 * Returned in the caller's order rather than re-sorted. If normalization flips
 * the leader and the runner-up, the margin comes out negative and the decision
 * lands on `uncertain` — which is the honest reading of a flip, and safer than
 * quietly attributing to whoever normalization happened to favour.
 */
async function normalizedScores(
  voiceprints: VoiceprintCollection,
  ranked: readonly ScoredMatch[],
  live: readonly { match: ScoredMatch }[],
): Promise<number[]> {
  return Promise.all(
    live.map(async ({ match }) => {
      const testSide = cohortStats(
        ranked.filter((other) => other.person_id !== match.person_id).map((other) => other.cosine),
      );

      const mirror = await voiceprints
        .aggregate<VoiceprintMatch>(
          voiceprintSearchPipeline(match.embedding, undefined, COHORT_SEARCH_LIMIT),
        )
        .toArray();
      const enrolledSide = cohortStats(
        mirror
          .filter((other) => other.person_id !== match.person_id)
          .map((other) => rawCosine(other.score)),
      );

      return adaptiveSNorm(match.cosine, testSide, enrolledSide);
    }),
  );
}

/**
 * How many voiceprints to pull back when attributing.
 *
 * Three was enough when the decision was "is the nearest one above 0.6". It is
 * not enough to normalize: AS-norm needs a cohort of people the trial is
 * definitely NOT, and three neighbours are all plausibly the right answer.
 * DEFAULT_COHORT_SIZE imposters plus a few rows of headroom for the candidate's
 * own duplicate voiceprints is the smallest search that supports the decision.
 */
export const COHORT_SEARCH_LIMIT = DEFAULT_COHORT_SIZE + 5;

export function voiceprintSearchPipeline(
  embedding: number[],
  personId?: string,
  limit = 3,
): PipelineStage[] {
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
        // Atlas needs a candidate pool well above the requested limit or the
        // approximate search returns a truncated, biased neighbourhood — which
        // for a cohort means normalizing against the wrong background.
        numCandidates: Math.max(60, limit * 12),
        limit,
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

export function createIdentityService(_options: IdentityServiceOptions): IdentityService {
  const { collections, bus } = _options;
  const timestamp = () => (_options.now?.() ?? new Date()).toISOString();

  return {
    async attributeSpeaker(input) {
      // Tunable at the venue: the contract floor is the safe default, but a room where
      // people talk in short turns produces almost no attributions at 3s. Lower it to trade
      // voiceprint confidence for coverage.
      const embedFloorMs = Number(process.env.EMBED_MIN_MS ?? EMBED_MIN_MS)
      if (input.duration_ms < embedFloorMs) {
        return { status: 'pending', reason: 'below_floor' };
      }

      const matches = await collections.voiceprints
        .aggregate<VoiceprintMatch>(
          voiceprintSearchPipeline(input.embedding, undefined, COHORT_SEARCH_LIMIT),
        )
        .toArray();

      const threshold = attributionThreshold();

      /**
       * One score per person, not per voiceprint.
       *
       * Somebody enrolled five times has five rows in the index and can fill the
       * whole result list, which makes the runner-up look absent and the cohort
       * look like one person. The decision is about people, so collapse first.
       */
      const bestPerPerson = new Map<string, ScoredMatch>();
      for (const match of matches) {
        const cosine = rawCosine(match.score);
        const held = bestPerPerson.get(match.person_id);
        if (!held || cosine > held.cosine) bestPerPerson.set(match.person_id, { ...match, cosine });
      }
      const ranked = [...bestPerPerson.values()].sort((left, right) => right.cosine - left.cosine);

      /**
       * Walk the candidates rather than trusting only the nearest.
       *
       * A voiceprint whose person has been merged away or deleted still sits in
       * the vector index and still wins the search. Throwing on it — which is
       * what this used to do — took down attribution for that speaker entirely:
       * the session swallows the error and retries, hits the same orphan, and
       * the speaker stays nameless for the whole conversation. One stale row
       * silently disabled recognition for the person it used to belong to.
       */
      const live: { match: ScoredMatch; person: Person }[] = [];
      for (const match of ranked) {
        if (live.length === 2) break;
        const candidate = await collections.people.findOne({
          _id: match.person_id,
          owner_id: OWNER_ID,
        });
        if (!candidate) {
          console.warn(
            `orphaned voiceprint ${match._id} points at missing person ${match.person_id} — skipping`,
          );
          continue;
        }
        live.push({ match, person: candidate });
      }

      const [leader, runnerUp] = live;
      let best: { voiceprint: VoiceprintMatch; confidence: number; person: Person } | undefined;

      if (leader && leader.match.cosine >= threshold) {
        /**
         * The raw cosine still owns "is anybody in the database plausible" —
         * AS-norm is only allowed to TIGHTEN that answer, never to loosen it.
         *
         * The reason is that the sigma thresholds are not fitted. Nothing in
         * this repo measures the open-set decision: every eval speaker is
         * enrolled, there is no held-out imposter, so the harness cannot tell a
         * correct rejection from an error and would reward any threshold that
         * accepts more. Replacing one unfitted constant with three would be
         * motion, not progress.
         *
         * What does NOT need fitting is the relative part. When two people both
         * score well, picking the higher of two near-identical scores is a coin
         * toss, and losing it merges one person's history into another's. The
         * margin is measured in deviations above each candidate's own cohort,
         * so it also catches the grabby voiceprint that sits close to everybody
         * — the mechanism by which one person slowly swallows the database.
         *
         * A rejected margin returns `pending`, not a new person. The caller
         * already retries with more audio, which is the honest response to
         * ambiguity: a stranger is a new person, a friend heard poorly is a
         * reason to wait.
         */
        const decision = decideSpeaker(
          await normalizedScores(collections.voiceprints, ranked, live),
          {
            accept: Number.NEGATIVE_INFINITY,
            reject: Number.NEGATIVE_INFINITY,
            margin: marginSigma(),
          },
        );

        if (decision.kind !== 'match') {
          console.warn(
            `attribution held: ${leader.person._id} scored ${leader.match.cosine.toFixed(3)} raw ` +
              `but only ${decision.kind === 'uncertain' ? decision.margin.toFixed(2) : '?'}σ clear of ` +
              `${runnerUp?.person._id ?? 'nobody'}`,
          );
          return { status: 'pending', reason: 'ambiguous' };
        }

        best = {
          voiceprint: leader.match,
          confidence: leader.match.cosine,
          person: leader.person,
        };
      }

      if (best) {
        const person = best.person;
        await collections.utterances.updateMany(
          { _id: { $in: input.utterance_ids }, owner_id: OWNER_ID },
          {
            $set: {
              person_id: person._id,
              voiceprint_id: best.voiceprint._id,
              updated_at: timestamp(),
            },
          },
        );
        bus.emit({
          type: 'identity',
          conversation_id: input.conversation_id,
          person_id: person._id,
          voiceprint_id: best.voiceprint._id,
          name: person.name,
          utterance_ids: input.utterance_ids,
        });
        return {
          status: 'matched',
          person_id: person._id,
          voiceprint_id: best.voiceprint._id,
          confidence: best.confidence,
        };
      }

      const now = timestamp();
      const person: Person = {
        _id: crypto.randomUUID(),
        owner_id: OWNER_ID,
        name: 'Unknown',
        created_at: now,
        updated_at: now,
      };
      const voiceprint: Voiceprint = {
        _id: crypto.randomUUID(),
        owner_id: OWNER_ID,
        person_id: person._id,
        embedding: input.embedding,
        duration_ms: input.duration_ms,
        created_at: now,
      };
      await collections.people.insertOne(person);
      await collections.voiceprints.insertOne(voiceprint);
      await collections.utterances.updateMany(
        { _id: { $in: input.utterance_ids }, owner_id: OWNER_ID },
        {
          $set: {
            person_id: person._id,
            voiceprint_id: voiceprint._id,
            updated_at: now,
          },
        },
      );
      bus.emit({
        type: 'identity',
        conversation_id: input.conversation_id,
        person_id: person._id,
        voiceprint_id: voiceprint._id,
        name: person.name,
        utterance_ids: input.utterance_ids,
      });
      return { status: 'created', person_id: person._id, voiceprint_id: voiceprint._id };
    },
    async isOwnerVoice(embedding) {
      const owner = await collections.people.findOne({ owner_id: OWNER_ID, is_owner: true });
      if (!owner) return { authorized: false, confidence: 0 };

      const [match] = await collections.voiceprints
        .aggregate<VoiceprintMatch>(voiceprintSearchPipeline(embedding, owner._id))
        .toArray();
      if (!match) return { authorized: false, confidence: 0 };

      const confidence = rawCosine(match.score);
      return { authorized: confidence >= ownerAuthThreshold(), confidence };
    },
    async enroll(request) {
      if (!request.embedding || request.embedding.length !== VOICEPRINT_DIMS) {
        throw new Error(`Voiceprint embeddings must have ${VOICEPRINT_DIMS} dimensions`);
      }

      let person: Person | null;
      if (request.person_id) {
        person = await collections.people.findOne({
          _id: request.person_id,
          owner_id: OWNER_ID,
        });
        if (!person) throw new Error(`Unknown person: ${request.person_id}`);
      } else {
        const now = timestamp();
        person = {
          _id: crypto.randomUUID(),
          owner_id: OWNER_ID,
          name: request.name ?? 'Unknown',
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
        duration_ms: request.duration_ms,
        ...(request.utterance_id ? { source_utterance_id: request.utterance_id } : {}),
        created_at: timestamp(),
      };
      await collections.voiceprints.insertOne(voiceprint);
      const { embedding: _embedding, ...publicVoiceprint } = voiceprint;
      return { person, voiceprint: publicVoiceprint };
    },
    async namePerson(personId, request) {
      const person = await collections.people.findOne({ _id: personId, owner_id: OWNER_ID });
      if (!person) throw new Error(`Unknown person: ${personId}`);

      const changes: Partial<Person> = {
        name: request.name,
        updated_at: timestamp(),
        ...(request.relationship !== undefined ? { relationship: request.relationship } : {}),
      };
      await collections.people.updateOne(
        { _id: personId, owner_id: OWNER_ID },
        { $set: changes },
      );
      const updatedPerson = { ...person, ...changes };
      const utterances = await collections.utterances.find({
        owner_id: OWNER_ID,
        person_id: personId,
      }).toArray();
      const utterancesByConversation = new Map<string, string[]>();
      for (const utterance of utterances) {
        const utteranceIds = utterancesByConversation.get(utterance.conversation_id) ?? [];
        utteranceIds.push(utterance._id);
        utterancesByConversation.set(utterance.conversation_id, utteranceIds);
      }
      for (const [conversationId, utteranceIds] of utterancesByConversation) {
        bus.emit({
          type: 'identity',
          conversation_id: conversationId,
          person_id: personId,
          name: updatedPerson.name,
          utterance_ids: utteranceIds,
        });
      }
      return updatedPerson;
    },
    async mergePeople(request) {
      const personIds = [...new Set(request.person_ids)];
      if (personIds.length < 2) throw new Error('At least two people are required to merge');

      const people = await collections.people.find({
        _id: { $in: personIds },
        owner_id: OWNER_ID,
      }).toArray();
      if (people.length !== personIds.length) throw new Error('Cannot merge unknown people');

      const survivor = people.reduce((oldest, person) => (
        person.created_at < oldest.created_at ? person : oldest
      ));
      const loserIds = personIds.filter((personId) => personId !== survivor._id);
      const affectedFilter = { owner_id: OWNER_ID, person_id: { $in: loserIds } };
      const conversationIds = (await collections.utterances.distinct(
        'conversation_id',
        affectedFilter,
      )).filter((id): id is string => typeof id === 'string');
      const affectedUtterances = await collections.utterances.find(affectedFilter).toArray();

      await collections.voiceprints.updateMany(affectedFilter, {
        $set: { person_id: survivor._id },
      });
      await collections.utterances.updateMany(affectedFilter, {
        $set: { person_id: survivor._id, updated_at: timestamp() },
      });
      await collections.facts.updateMany(affectedFilter, {
        $set: { person_id: survivor._id },
      });
      await collections.promises.updateMany(affectedFilter, {
        $set: { person_id: survivor._id },
      });
      await collections.people.deleteMany({
        _id: { $in: loserIds },
        owner_id: OWNER_ID,
      });

      for (const conversationId of conversationIds) {
        bus.emit({
          type: 'identity',
          conversation_id: conversationId,
          person_id: survivor._id,
          name: survivor.name,
          utterance_ids: affectedUtterances
            .filter((utterance) => utterance.conversation_id === conversationId)
            .map((utterance) => utterance._id),
        });
      }
      return survivor;
    },
  };
}
