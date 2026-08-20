import { describe, expect, it } from 'vitest';
import type { Person } from '../../shared/contracts';
import { labelSpeakers, UNATTRIBUTED_LABEL } from './speakers';

function person(id: string, over: Partial<Person> = {}): Person {
  return {
    _id: id,
    owner_id: 'owner',
    name: '',
    created_at: 'now',
    updated_at: 'now',
    ...over,
  };
}

describe('speaker labels', () => {
  const people = [
    person('p-owner', { name: 'Boris', is_owner: true }),
    person('p-mert', { name: 'Mert' }),
    person('p-voice', { name: 'Unknown speaker', is_unnamed: true }),
  ];

  const turns = [
    { person_id: 'p-owner' },
    { person_id: 'p-voice' },
    { person_id: 'p-mert' },
    { person_id: 'p-other' },
    {},
  ];

  it('addresses the owner as the person being spoken to', () => {
    expect(labelSpeakers(turns, people).label('p-owner')).toBe('You');
  });

  it('uses a name when the voice has been named', () => {
    expect(labelSpeakers(turns, people).label('p-mert')).toBe('Mert');
  });

  it('never puts a name to a voice that has not been named', () => {
    const labels = labelSpeakers(turns, people);
    expect(labels.label('p-voice')).toBe('Speaker 1');
    expect(labels.label('p-other')).toBe('Speaker 2');
  });

  it('numbers unnamed voices in the order they first speak, stably', () => {
    const labels = labelSpeakers(turns, people);
    expect(labels.label('p-voice')).toBe('Speaker 1');
    expect(labels.label('p-voice')).toBe('Speaker 1');
  });

  it('says plainly when a turn was never attributed to a voice', () => {
    expect(labelSpeakers(turns, people).label(undefined)).toBe(UNATTRIBUTED_LABEL);
  });

  it('does not treat a blank name as a name', () => {
    const labels = labelSpeakers([{ person_id: 'p-blank' }], [person('p-blank', { name: '   ' })]);
    expect(labels.label('p-blank')).toBe('Speaker 1');
  });

  it('reports the roster in order of first appearance', () => {
    expect(labelSpeakers(turns, people).roster()).toEqual([
      'You',
      'Speaker 1',
      'Mert',
      'Speaker 2',
      UNATTRIBUTED_LABEL,
    ]);
  });
});
