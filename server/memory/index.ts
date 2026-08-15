import type { Hono } from 'hono';
import type {
  AskRequest,
  ConversationSummary,
  MemoryApi,
  ServerDependencies,
} from '../../shared/contracts';
import type { AmeliaBus } from '../lib/bus';
import { answerQuestion } from '../ask';
import { searchMemory } from '../ask/retrieval';
import { listContextChanges } from './changes';
import { flushSlowPass, registerExtraction } from './extraction';
import * as store from './store';

/**
 * `addNote` needs the bus to announce the fact it writes, but the frozen
 * signature has no room for it, so registration parks the bus here.
 */
let activeBus: AmeliaBus | undefined;

function requireBus(): AmeliaBus {
  if (!activeBus) throw new Error('memory API used before registerMemoryRoutes / createMemoryApi');
  return activeBus;
}

export const getPerson: MemoryApi['getPerson'] = (id) => store.getPerson(id);
export const resolveFactState: MemoryApi['resolveFactState'] = (personId, attribute) =>
  store.resolveFactState(personId, attribute);
export const createReminder: MemoryApi['createReminder'] = (promiseId, fireAt) =>
  store.createReminder(promiseId, fireAt);
export const addNote: MemoryApi['addNote'] = (personId, text) => store.addNote(requireBus(), personId, text);
export { searchMemory };

/** The frozen cross-lane surface. Lane D imports these and nothing else. */
export function createMemoryApi(deps: { bus: AmeliaBus }): MemoryApi {
  activeBus = deps.bus;
  return { searchMemory, getPerson, resolveFactState, createReminder, addNote };
}

export function registerMemoryRoutes(app: Hono, deps: ServerDependencies): void {
  const bus = deps.bus as AmeliaBus;
  activeBus = bus;
  registerExtraction(bus);

  app.get('/people', async (context) => context.json(await store.listPeople()));

  app.get('/people/:id', async (context) => {
    const person = await getPerson(context.req.param('id'));
    return person ? context.json(person) : context.json({ error: 'person not found' }, 404);
  });

  // `POST /people/merge` and `POST /people/:id/name` are registered by
  // server/identity/index.ts, which is the single implementation of both.
  //
  // This lane used to register its own copies on the same two paths. They never
  // ran — server/index.ts registers identity first and Hono takes the first
  // handler — but they disagreed on real behaviour, so which one you read
  // determined what you believed the endpoint did. Renaming here emitted a
  // relabel with an empty `utterance_ids`, which tells the app nothing about
  // which lines to re-render.

  app.get('/conversations', async (context) => context.json(await store.listConversations()));

  app.delete('/conversations/:id', async (context) =>
    context.json(await store.deleteConversation(context.req.param('id'))));

  app.get('/conversations/:id', async (context) => {
    const conversationId = context.req.param('id');
    const utterances = await store.listUtterances(conversationId);
    const conversation = (await store.getConversation(conversationId)) ?? {
      _id: conversationId,
      owner_id: utterances[0]?.owner_id ?? '',
      started_at: utterances[0]?.created_at ?? new Date().toISOString(),
      participant_ids: [],
    };
    const participantIds = [...new Set(utterances.flatMap((item) => (item.person_id ? [item.person_id] : [])))];
    const participants = (await Promise.all(participantIds.map(getPerson))).filter(
      (person): person is NonNullable<typeof person> => person !== null,
    );
    const summary: ConversationSummary = { conversation, utterances, participants };
    return context.json(summary);
  });

  app.get('/memory/search', async (context) => {
    const query = context.req.query('q');
    if (!query) return context.json({ error: 'q is required' }, 400);
    return context.json(await searchMemory(query, context.req.query('person_id')));
  });

  app.get('/memory/changes', async (context) => {
    const requested = Number(context.req.query('limit') ?? 10);
    return context.json(await listContextChanges(Number.isFinite(requested) ? requested : 10));
  });

  app.get('/promises', async (context) => {
    const status = context.req.query('status') as 'open' | 'done' | 'cancelled' | undefined;
    return context.json(await store.listPromises(status));
  });

  app.post('/promises/:id/status', async (context) => {
    const body = await context.req.json<{ status: 'open' | 'done' | 'cancelled' }>();
    const updated = await store.setPromiseStatus(context.req.param('id'), body.status, bus);
    return updated ? context.json(updated) : context.json({ error: 'promise not found' }, 404);
  });

  // The fixture transcript is shorter than the slow-pass interval, so the fact
  // and supersession pass needs a way to be run on demand.
  app.post('/memory/extract/:conversationId', async (context) => {
    await flushSlowPass(bus, context.req.param('conversationId'));
    return context.json({ ok: true });
  });

  app.post('/ask', async (context) => {
    const body = await context.req.json<AskRequest>();
    return context.json(await answerQuestion(body));
  });

  app.post('/reminders', async (context) => {
    const body = await context.req.json<{ promise_id: string; fire_at: string }>();
    return context.json(await createReminder(body.promise_id, body.fire_at));
  });
}
