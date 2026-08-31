import { describe, expect, it, vi } from 'vitest';
import type { Fact, MemoryApi, Person } from '../../shared/contracts';
import type { AssembledContext } from '../ask/context';
import { createFixtureMemory } from './fixture-memory';
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

// The fixture double keeps its people and facts in module-level arrays, so
// writes leak between `createFixtureMemory()` calls in the same file. Every
// test below therefore touches its own person or its own attribute name.

describe('set_name', () => {
  it('renames the person and reports the new name', async () => {
    const memory = createFixtureMemory();

    const outcome = await runTool(memory, 'set_name', {
      person_id: 'p-jules',
      name: 'Jules Okafor',
    });

    expect(outcome.isError).toBeUndefined();
    expect(outcome.message).toBe('Named Jules Okafor');
    expect((outcome.result as { name: string }).name).toBe('Jules Okafor');
    expect(await memory.getPerson('p-jules')).toMatchObject({ name: 'Jules Okafor' });
  });

  it('reports an error for an unknown person instead of claiming the rename worked', async () => {
    const memory = createFixtureMemory();

    const outcome = await runTool(memory, 'set_name', {
      person_id: 'p-nobody',
      name: 'Ghost',
    });

    expect(outcome.isError).toBe(true);
    expect(outcome.message).toBe('No person matching "p-nobody"');
    expect(outcome.message).not.toMatch(/named/i);
    expect(outcome.result).toEqual({ error: 'no such person', person_id: 'p-nobody' });
  });

  it('passes a stated relationship through and omits it when none was said', async () => {
    const withRelationship = createFixtureMemory();
    const withoutRelationship = createFixtureMemory();

    await runTool(withRelationship, 'set_name', {
      person_id: 'p-priya',
      name: 'Priya',
      relationship: 'lab partner',
    });
    await runTool(withoutRelationship, 'set_name', { person_id: 'p-priya', name: 'Priya' });

    expect(withRelationship.calls).toContain('namePerson(p-priya, Priya, lab partner)');
    expect(withoutRelationship.calls).toContain('namePerson(p-priya, Priya)');
    expect(await withRelationship.getPerson('p-priya')).toMatchObject({
      relationship: 'lab partner',
    });
  });
});

describe('set_birthday', () => {
  it('records the spoken date and reports it against the person name', async () => {
    const memory = createFixtureMemory();

    const outcome = await runTool(memory, 'set_birthday', {
      person_id: 'p-maya',
      birthday: 'July 15',
    });

    expect(outcome.isError).toBeUndefined();
    expect(outcome.message).toBe("Maya's birthday: July 15");
    expect(outcome.result).toMatchObject({
      person_id: 'p-maya',
      attribute: 'birthday',
      claim: 'July 15',
    });
  });

  it('reports an error for an unknown person and writes no fact at all', async () => {
    const memory = createFixtureMemory();

    const outcome = await runTool(memory, 'set_birthday', {
      person_id: 'p-nobody',
      birthday: 'July 15',
    });

    expect(outcome.isError).toBe(true);
    expect(outcome.message).toBe('No person matching "p-nobody"');
    expect(memory.calls.some((call) => call.startsWith('setFact('))).toBe(false);
  });

  it('writes the fact against the resolved person id rather than the raw spoken input', async () => {
    const memory = createFixtureMemory();

    const outcome = await runTool(memory, 'set_birthday', {
      person_id: 'Maya',
      birthday: '2 March',
    });

    expect(outcome.isError).toBeUndefined();
    expect(memory.calls).toContain('setFact(p-maya, birthday, 2 March)');
    expect(memory.calls.some((call) => call.startsWith('setFact(Maya,'))).toBe(false);
    expect((outcome.result as Fact).person_id).toBe('p-maya');
  });

  it('writes a birthday that resolve_fact_state can then read back', async () => {
    const memory = createFixtureMemory();

    await runTool(memory, 'set_birthday', { person_id: 'p-jules', birthday: 'November 4' });
    const readBack = await runTool(memory, 'resolve_fact_state', {
      person_id: 'p-jules',
      attribute: 'birthday',
    });

    expect(readBack.message).toBe('birthday: November 4');
    expect((readBack.result as Fact).claim).toBe('November 4');
  });
});

describe('the resolve_fact_state controlled vocabulary', () => {
  it('advertises birthday to the model in the tool description', () => {
    const spec = TOOLS.find((tool) => tool.name === 'resolve_fact_state');

    expect(spec?.description).toContain('birthday');
  });

  it('names birthday in the hint returned when an attribute misses', async () => {
    const memory = createFixtureMemory();

    const outcome = await runTool(memory, 'resolve_fact_state', {
      person_id: 'p-maya',
      attribute: 'shoe_size',
    });

    expect((outcome.result as { hint: string }).hint).toContain('birthday');
  });
});

describe('an unrecognised tool name', () => {
  it('still returns the unknown-tool error', async () => {
    const memory = createFixtureMemory();

    const outcome = await runTool(memory, 'delete_person', { person_id: 'p-maya' });

    expect(outcome.isError).toBe(true);
    expect(outcome.message).toBe('Unknown tool: delete_person');
    expect(outcome.result).toEqual({ error: 'Unknown tool: delete_person' });
  });
});

/**
 * setFact's supersession semantics.
 *
 * The real implementation is `server/memory/store.setFact`, which needs a live
 * Mongo connection and has no harness in this repository, so these pin the
 * semantics through the fixture double that Lane D actually runs against. They
 * are a contract check on the double, not coverage of store.ts.
 */
describe('setFact supersession semantics', () => {
  it('creates the fact when the attribute has no current value', async () => {
    const memory = createFixtureMemory();

    const written = await memory.setFact('p-priya', 'first_write', 'Portland');

    expect(written).toMatchObject({ attribute: 'first_write', claim: 'Portland' });
    expect(written.superseded_by).toBeUndefined();
    expect(await memory.resolveFactState('p-priya', 'first_write')).toMatchObject({
      claim: 'Portland',
    });
  });

  it('supersedes the previous value when a different one is set', async () => {
    const memory = createFixtureMemory();

    const first = await memory.setFact('p-priya', 'supersede_me', 'Portland');
    const second = await memory.setFact('p-priya', 'supersede_me', 'Oakland');

    expect(second._id).not.toBe(first._id);
    expect(first.superseded_by).toBe(second._id);
    expect(first.superseded_at).toBe(second.valid_from);
    expect(second.superseded_by).toBeUndefined();
    expect(await memory.resolveFactState('p-priya', 'supersede_me')).toMatchObject({
      _id: second._id,
      claim: 'Oakland',
    });
  });

  // The double used to write a second row and supersede the first even when the
  // claim was unchanged, while store.setFact returned the current fact
  // untouched. That divergence mattered because this double is what the demo
  // path runs against, so a restated value read as a change there and not in
  // Mongo. Both now share the guard, and both normalize the claim the same way.
  it('treats setting the same value again as a no-op', async () => {
    const memory = createFixtureMemory();

    const first = await memory.setFact('p-priya', 'same_value', 'Portland');
    const again = await memory.setFact('p-priya', 'same_value', 'Portland');

    expect(again._id).toBe(first._id);
    expect(first.superseded_by).toBeUndefined();
    expect(first.superseded_at).toBeUndefined();
  });

  it('ends a revert with the original value current and a three-link history', async () => {
    const memory = createFixtureMemory();

    const a1 = await memory.setFact('p-priya', 'revert_case', 'Portland');
    const b = await memory.setFact('p-priya', 'revert_case', 'Oakland');
    const a2 = await memory.setFact('p-priya', 'revert_case', 'Portland');

    expect(a2._id).not.toBe(a1._id);
    expect(a1.superseded_by).toBe(b._id);
    expect(b.superseded_by).toBe(a2._id);
    expect(a2.superseded_by).toBeUndefined();

    const current = await memory.resolveFactState('p-priya', 'revert_case');
    expect(current).toMatchObject({ _id: a2._id, claim: 'Portland' });
  });

  it('keys each transition on its predecessor so a revert cannot resurrect a superseded row', async () => {
    const memory = createFixtureMemory();

    const a1 = await memory.setFact('p-priya', 'revert_source', 'Portland');
    const b = await memory.setFact('p-priya', 'revert_source', 'Oakland');
    const a2 = await memory.setFact('p-priya', 'revert_source', 'Portland');

    expect(a1.primary_source_utterance_id).toBe('spoken-revert_source-initial');
    expect(b.primary_source_utterance_id).toBe(`spoken-revert_source-${a1._id}`);
    expect(a2.primary_source_utterance_id).toBe(`spoken-revert_source-${b._id}`);
    expect(a2.primary_source_utterance_id).not.toBe(a1.primary_source_utterance_id);
  });
});
