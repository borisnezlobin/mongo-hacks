import type { Hono } from 'hono';
import { MongoClient } from 'mongodb';
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
import {
  createIdentityService,
  type IdentityCollection,
  type IdentityService,
} from './service';

export { createIdentityService } from './service';
export type { IdentityService, IdentityServiceOptions } from './service';

function collection<T>(value: unknown): IdentityCollection<T> {
  return value as IdentityCollection<T>;
}

export function registerIdentityRoutes(app: Hono, deps: ServerDependencies): void {
  let servicePromise: Promise<IdentityService> | undefined;

  const getService = async (): Promise<IdentityService> => {
    if (!servicePromise) {
      const uri = process.env.MONGODB_URI;
      if (!uri) throw new Error('MONGODB_URI is required for identity routes');

      servicePromise = (async () => {
        const client = new MongoClient(uri);
        await client.connect();
        const db = client.db();
        return createIdentityService({
          collections: {
            people: collection<Person>(db.collection<Person>('people')),
            voiceprints: collection<Voiceprint>(db.collection<Voiceprint>('voiceprints')),
            utterances: collection<Utterance>(db.collection<Utterance>('utterances')),
            facts: collection<Fact>(db.collection<Fact>('facts')),
            promises: collection<PromiseMemory>(db.collection<PromiseMemory>('promises')),
          },
          bus: deps.bus,
        });
      })();
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
    const request = await context.req.json<NamePersonRequest>();
    const response = await (await getService()).namePerson(context.req.param('id'), request);
    return context.json(response);
  });

  app.post('/people/merge', async (context) => {
    const request = await context.req.json<MergePeopleRequest>();
    const response = await (await getService()).mergePeople(request);
    return context.json(response);
  });
}
