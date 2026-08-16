import { describe, expect, it } from 'vitest';
import type { Fact } from '../../shared/contracts';
import { createFixtureMemory } from './fixture-memory';
import { TOOLS, runTool } from './tools';

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
