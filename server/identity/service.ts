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
import {
  ATTRIBUTION_THRESHOLD,
  EMBED_MIN_MS,
  OWNER_AUTH_THRESHOLD,
  OWNER_ID,
  VOICEPRINT_DIMS,
} from '../../shared/contracts';
import { decideSpeaker } from './score-norm';

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
    final?: boolean;
  }): Promise<
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

const SEARCH_LIMIT = 3;

/**
 * Rows to ask for when the margin is on. The margin is a statement about the
 * nearest OTHER person, and one person routinely owns several prints — every
 * enrollment adds one, and a merge repoints all of the loser's onto the
 * survivor — so a three-row window can be filled by a single person and hide
 * the rival entirely. Deep enough that a well-enrolled person cannot crowd the
 * runner-up out, still far inside numCandidates.
 */
const MARGIN_SEARCH_LIMIT = 12;

export function voiceprintSearchPipeline(
  embedding: number[],
  personId?: string,
  limit: number = SEARCH_LIMIT,
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
        numCandidates: 60,
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

/**
 * `??` rescues an absent variable but not an empty one, and a copied
 * .env.example hands us `''` for anything documented as "leave blank for the
 * default" — which Number() turns into a silent 0. A tuning knob that reads 0
 * because nobody typed a number is worse than no knob at all, so anything that
 * is not a finite number means "use the default".
 */
function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
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
      const embedFloorMs = envNumber('EMBED_MIN_MS', EMBED_MIN_MS)
      if (input.duration_ms < embedFloorMs) {
        return { status: 'pending', reason: 'below_floor' };
      }

      const threshold = envNumber('ATTRIBUTION_THRESHOLD', ATTRIBUTION_THRESHOLD)

      const marginCosine = envNumber('IDENTITY_MARGIN_COSINE', 0);

      // How deep to walk. With no margin configured the runner-up cannot change
      // the answer, so stopping at the first live candidate keeps this path's
      // query count identical to what it has always been. A margin makes the
      // second DISTINCT person load-bearing, so pay for it only then.
      const wanted = marginCosine > 0 ? 2 : 1;

      const matches = await collections.voiceprints
        .aggregate<VoiceprintMatch>(
          voiceprintSearchPipeline(
            input.embedding,
            undefined,
            marginCosine > 0 ? MARGIN_SEARCH_LIMIT : SEARCH_LIMIT,
          ),
        )
        .toArray();

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
      const survivors: { voiceprint: VoiceprintMatch; confidence: number; person: Person }[] = [];
      const seenPeople = new Set<string>();
      for (const match of matches) {
        const confidence = rawCosine(match.score);
        if (confidence < threshold) break;
        // One person routinely owns several voiceprints, and their own second
        // print is not a rival. Deduping by person is what makes the margin a
        // statement about people rather than about rows.
        if (seenPeople.has(match.person_id)) continue;
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
        seenPeople.add(match.person_id);
        survivors.push({ voiceprint: match, confidence, person: candidate });
        if (survivors.length >= wanted) break;
      }

      const decision = decideSpeaker(
        survivors.map((survivor) => survivor.confidence),
        { accept: threshold, reject: threshold, margin: marginCosine },
      );

      // Nothing more is coming, so a coin toss beats a nameless speaker: fall
      // through to the top candidate, which is the answer this code has always
      // given. Waiting is only ever an improvement while more audio is arriving.
      if (decision.kind === 'uncertain' && decision.reason === 'ambiguous' && !input.final) {
        return { status: 'pending', reason: 'ambiguous' };
      }

      const best = decision.kind === 'new' ? undefined : survivors[0];

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
      return { authorized: confidence >= OWNER_AUTH_THRESHOLD, confidence };
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
