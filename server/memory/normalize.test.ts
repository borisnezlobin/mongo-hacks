import { describe, expect, it } from 'vitest';
import { factAttributeAliases } from './normalize';

describe('fact attribute aliases', () => {
  it('resolves legacy move_date facts through the stable move key', () => {
    expect(factAttributeAliases('move')).toEqual(['move', 'move_date']);
    expect(factAttributeAliases('move_date')).toEqual(['move', 'move_date']);
  });

  it('leaves unknown and already-specific attributes unchanged', () => {
    expect(factAttributeAliases('email')).toEqual(['email']);
  });
});
