import { describe, expect, it, vi } from 'vitest';
import type { MemoryApi, Person } from '../../shared/contracts';
import type { AssembledContext } from '../ask/context';
import { runTool, TOOLS, type RetrievalTools } from './tools';

const memory = {
  searchMemory: vi.fn(async () => []),
  getPerson: vi.fn(async () => null),
  resolveFactState: vi.fn(async () => null),
  createReminder: vi.fn(),
  addNote: vi.fn(),
} as unknown as MemoryApi;

function person(id: string, over: Partial<Person> = {}): Person {
  return { _id: id, owner_id: 'owner', name: '', created_at: 'now', updated_at: 'now', ...over };
}

const context: AssembledContext = {
  conversations: [
    { id: 'c1', started_at: '2026-08-16T21:00:00.000Z', speakers: ['You', 'Speaker 1'], utterances: 2_772 },
  ],
  timeline: [{ at: '0:00', speakers: ['You'], topics: ['orientation', 'dorm'] }],
  blocks: [
    {
      passage_id: 'c1#3',
      conversation_id: 'c1',
      at: '4:20',
      speakers: ['Speaker 1'],
      topics: ['sophomore'],
      quotes: [{ utterance_id: 'u-9', speaker: 'Speaker 1', at: '4:21', text: 'I am a sophomore actually' }],
    },
  ],
  coverage: { passages: 61, passages_quoted: 16, quoted_words: 480 },
  citable_utterance_ids: ['u-9'],
};

function retrieval(over: Partial<RetrievalTools> = {}): RetrievalTools {
  return {
    assembleContext: vi.fn(async () => context),
    recentConversations: vi.fn(async () => []),
    listPeople: vi.fn(async () => []),
    ...over,
  } as RetrievalTools;
}

describe('the tool vocabulary', () => {
  it('is general rather than one tool per question', () => {
    const names = TOOLS.map((tool) => tool.name);
    expect(names).toContain('gather_context');
    expect(names).toContain('search_memory');
    expect(names.some((name) => /summar/i.test(name))).toBe(false);
  });

  it('lets a caller name a scope, a granularity and a budget', () => {
    const gather = TOOLS.find((tool) => tool.name === 'gather_context');
    expect(Object.keys(gather!.parameters.properties as object).sort()).toEqual([
      'about',
      'budget_words',
      'conversation_id',
      'granularity',
      'person_id',
      'since',
      'until',
    ]);
  });
});

describe('gather_context', () => {
  it('passes the scope straight through', async () => {
    const tools = retrieval();
    await runTool(
      memory,
      'gather_context',
      { conversation_id: 'c1', person_id: 'p-1', about: 'his startup', granularity: 'detail', budget_words: 300 },
      tools,
    );

    expect(tools.assembleContext).toHaveBeenCalledWith(
      { conversation_id: 'c1', person_id: 'p-1', since: undefined, until: undefined, about: 'his startup' },
      { granularity: 'detail', budget_words: 300 },
    );
  });

  it('returns lines the model can quote and cite', async () => {
    const outcome = await runTool(memory, 'gather_context', {}, retrieval());
    const result = outcome.result as { excerpts: Array<{ lines: string[] }> };

    expect(result.excerpts[0].lines).toEqual(['(id u-9) Speaker 1: I am a sophomore actually']);
    expect(outcome.message).toContain('16 of 61 passages');
  });

  it('says plainly when the scope is empty', async () => {
    const tools = retrieval({
      assembleContext: vi.fn(async () => ({
        conversations: [],
        timeline: [],
        blocks: [],
        coverage: { passages: 0, passages_quoted: 0, quoted_words: 0 },
        citable_utterance_ids: [],
        note: 'Nothing is recorded in this scope.',
      })) as RetrievalTools['assembleContext'],
    });

    const outcome = await runTool(memory, 'gather_context', { conversation_id: 'c-missing' }, tools);
    expect(outcome.message).toMatch(/nothing recorded/i);
  });
});

describe('list_conversations', () => {
  it('names who was in the room without naming voices that have no name', async () => {
    const tools = retrieval({
      recentConversations: vi.fn(async () => [
        {
          _id: 'c1',
          owner_id: 'owner',
          started_at: '2026-08-16T21:00:00.000Z',
          participant_ids: ['p-owner', 'p-mert', 'p-voice'],
        },
      ]) as RetrievalTools['recentConversations'],
      listPeople: vi.fn(async () => [
        person('p-owner', { name: 'Boris', is_owner: true }),
        person('p-mert', { name: 'Mert' }),
        person('p-voice', { name: 'Unknown speaker', is_unnamed: true }),
      ]) as RetrievalTools['listPeople'],
    });

    const outcome = await runTool(memory, 'list_conversations', {}, tools);
    const [conversation] = outcome.result as Array<{ participants: Array<{ name: string }> }>;

    expect(conversation.participants.map((participant) => participant.name)).toEqual([
      'you',
      'Mert',
      'an unnamed voice',
    ]);
  });

  it('keeps the limit sane whatever the model asks for', async () => {
    const tools = retrieval();
    await runTool(memory, 'list_conversations', { limit: 5_000 }, tools);
    expect(tools.recentConversations).toHaveBeenCalledWith(50);
  });
});

describe('list_people', () => {
  it('marks which voices have actually been named', async () => {
    const tools = retrieval({
      listPeople: vi.fn(async () => [
        person('p-mert', { name: 'Mert' }),
        person('p-voice', { is_unnamed: true, name: 'Unknown speaker' }),
      ]) as RetrievalTools['listPeople'],
    });

    const outcome = await runTool(memory, 'list_people', {}, tools);
    expect(outcome.result).toEqual([
      { person_id: 'p-mert', name: 'Mert', named: true, relationship: undefined },
      { person_id: 'p-voice', name: 'an unnamed voice', named: false, relationship: undefined },
    ]);
  });
});

describe('failures', () => {
  it('reports a retrieval failure instead of throwing into the agent loop', async () => {
    const tools = retrieval({
      assembleContext: vi.fn(async () => {
        throw new Error('storage unavailable');
      }) as RetrievalTools['assembleContext'],
    });

    const outcome = await runTool(memory, 'gather_context', {}, tools);
    expect(outcome.isError).toBe(true);
    expect(outcome.message).toContain('storage unavailable');
  });
});
