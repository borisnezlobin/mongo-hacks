import type { Hono } from 'hono';
import type {
  EnrollVoiceRequest,
  Fact,
  MergePeopleRequest,
  NamePersonRequest,
  Person,
  PromiseMemory,
  ServerDependencies,
  Utterance,
  Voiceprint,
} from '../../shared/contracts';
import { getStorage } from '../storage';
import {
  createIdentityService,
  type IdentityCollection,
  type IdentityService,
  type NameEnrollment,
  type VoiceprintCollection,
} from './service';

export { UNNAMED_PERSON_NAME, createIdentityService } from './service';
export type {
  AttributionInput,
  AttributionResult,
  IdentityService,
  IdentityServiceOptions,
  NameEnrollment,
} from './service';

function collection<T>(value: unknown): IdentityCollection<T> {
  return value as IdentityCollection<T>;
}

function voiceprintCollection(value: unknown): VoiceprintCollection {
  return value as VoiceprintCollection;
}

/**
 * Naming a voice is enrollment. The client sends the name; whoever holds the
 * pooled speech for that voice — the audio session, or a client that captured
 * an enrollment clip — may send it along, and it becomes a permanent print so
 * the next session recognises them. The field is additive and optional, so the
 * frozen NamePersonRequest contract still describes the body.
 */
type NamePersonBody = NamePersonRequest & { enrollment?: NameEnrollment };

/**
 * One identity service per bus.
 *
 * The wake gate in server/index.ts used to re-implement owner scoring against
 * its own MongoClient and its own copy of the vector search, which is how the
 * two drifted: attribution moved to session-mean-subtracted cosine while the
 * wake gate stayed on raw Atlas scores. There should only ever be one place
 * that decides whether a voice is the owner.
 */
const servicesByBus = new WeakMap<object, Promise<IdentityService>>();

export function identityServiceFor(deps: ServerDependencies): Promise<IdentityService> {
  const existing = servicesByBus.get(deps.bus);
  if (existing) return existing;
  const created = (async () => {
    const storage = await getStorage();
    return createIdentityService({
      collections: {
        people: collection<Person>(storage.collection<Person>('people')),
        voiceprints: voiceprintCollection(storage.collection<Voiceprint>('voiceprints')),
        utterances: collection<Utterance>(storage.collection<Utterance>('utterances')),
        facts: collection<Fact>(storage.collection<Fact>('facts')),
        promises: collection<PromiseMemory>(storage.collection<PromiseMemory>('promises')),
      },
      bus: deps.bus,
    });
  })();
  servicesByBus.set(deps.bus, created);
  return created.catch((error: unknown) => {
    servicesByBus.delete(deps.bus);
    throw error;
  });
}

export function registerIdentityRoutes(app: Hono, deps: ServerDependencies): void {
  let servicePromise: Promise<IdentityService> | undefined;

  const getService = async (): Promise<IdentityService> => {
    if (!servicePromise) {
      servicePromise = identityServiceFor(deps);
    }

    try {
      return await servicePromise;
    } catch (error) {
      servicePromise = undefined;
      throw error;
    }
  };

  app.post('/audio/enroll', async (context) => {
    const request = await context.req.json<EnrollVoiceRequest>();
    const response = await (await getService()).enroll(request);
    return context.json(response, 201);
  });

  app.post('/people/:id/name', async (context) => {
    const { enrollment, ...request } = await context.req.json<NamePersonBody>();
    const response = await (await getService()).namePerson(
      context.req.param('id'),
      request,
      enrollment,
    );
    return context.json(response);
  });

  /**
   * Candidate duplicates, ranked. A GET because it decides nothing: the owner
   * confirms one by POSTing it to /people/merge, which is the only path that
   * writes. See server/identity/duplicates.ts for why it is split that way.
   */
  app.get('/people/duplicates', async (context) => {
    const limit = Number(context.req.query('limit'));
    const candidates = await (await getService()).duplicateCandidates(
      Number.isFinite(limit) && limit > 0 ? { limit } : undefined,
    );
    return context.json({ candidates });
  });

  app.post('/people/merge', async (context) => {
    const request = await context.req.json<MergePeopleRequest>();
    const response = await (await getService()).mergePeople(request);
    return context.json(response);
  });
}
