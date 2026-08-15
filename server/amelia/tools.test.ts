import { describe, expect, it } from 'vitest';
import { createFixtureMemory } from './fixture-memory';
import { runTool } from './tools';

describe('resolve_fact_state', () => {
  // The 20–32s beat of the video. An append-only fact store that only ever
  // reports the latest value is indistinguishable from an UPDATE statement;
  // the arrow is what makes the history visible.
  it('renders the supersession chain as old → new', async () => {
    const memory = createFixtureMemory();

    const outcome = await runTool(memory, 'resolve_fact_state', {
      person_id: 'p-maya',
      attribute: 'move',
    });

    expect(outcome.message).toBe(
      'move updated Moving to Oakland on September 1 → Moving to Oakland on September 15',
    );
  });

  it('gives the model the whole chain, not just the line it shows', async () => {
    const memory = createFixtureMemory();

    const outcome = await runTool(memory, 'resolve_fact_state', {
      person_id: 'p-maya',
      attribute: 'move',
    });

    const result = outcome.result as {
      current: { _id: string };
      superseded: { _id: string }[];
    };
    expect(result.current._id).toBe('f-maya-move-new');
    expect(result.superseded.map((fact) => fact._id)).toEqual(['f-maya-move-old']);
  });

  it('states the value plainly when nothing has replaced it', async () => {
    const memory = createFixtureMemory();

    const outcome = await runTool(memory, 'resolve_fact_state', {
      person_id: 'p-maya',
      attribute: 'food_preference',
    });

    expect(outcome.message).toBe('food preference: Loves Ethiopian food');
  });

  // A miss used to send the model hunting through attribute-name variants until
  // it burned the whole tool budget, so the miss has to be explicit.
  it('says plainly that an unknown attribute has nothing recorded', async () => {
    const memory = createFixtureMemory();

    const outcome = await runTool(memory, 'resolve_fact_state', {
      person_id: 'p-maya',
      attribute: 'oakland_move_date',
    });

    expect(outcome.message).toBe('Nothing recorded for oakland move date');
    expect(outcome.result).toMatchObject({ found: false });
  });
});
