import { describe, expect, it } from 'vitest';
import { FACT_ATTRIBUTES, canonicalFactAttribute, factAttributeAliases } from './normalize';

describe('fact attribute aliases', () => {
  it('resolves legacy move_date facts through the stable move key', () => {
    expect(factAttributeAliases('move')).toEqual(['move', 'move_date']);
    expect(factAttributeAliases('move_date')).toEqual(['move', 'move_date']);
  });

  it('leaves unknown and already-specific attributes unchanged', () => {
    expect(factAttributeAliases('email')).toEqual(['email']);
  });
});

describe('canonical fact vocabulary', () => {
  it('folds every legacy spelling onto one slot so supersession can key on it', () => {
    expect(canonicalFactAttribute('move_date')).toBe('move');
    expect(canonicalFactAttribute('food_preference')).toBe('preference');
    expect(canonicalFactAttribute('work')).toBe('job');
    expect(canonicalFactAttribute('major')).toBe('study');
  });

  it('accepts the spacing and casing a caller might guess at', () => {
    expect(canonicalFactAttribute('Move Date')).toBe('move');
    expect(canonicalFactAttribute('class-year')).toBe('academic_year');
  });

  it('passes an attribute it has never seen through untouched', () => {
    expect(canonicalFactAttribute('email')).toBe('email');
  });

  it('is idempotent, so a canonical key never re-maps', () => {
    for (const attribute of FACT_ATTRIBUTES) {
      expect(canonicalFactAttribute(attribute)).toBe(attribute);
    }
  });

  it('reaches every alias group from either spelling', () => {
    for (const attribute of FACT_ATTRIBUTES) {
      for (const alias of factAttributeAliases(attribute)) {
        expect(factAttributeAliases(alias)).toEqual(factAttributeAliases(attribute));
      }
    }
  });
});
