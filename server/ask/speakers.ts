/**
 * Turning a person_id into something an answer can say out loud.
 *
 * "Who said what" is the whole product, so attribution has to survive every
 * reduction step — which means every line of assembled context carries a label,
 * and the label is never a guess. A voice we can tell apart but cannot name is
 * "Speaker 2", not the nearest plausible name, because a confident wrong name
 * attached to a real person is the worst failure this system has.
 */

import type { Person } from '../../shared/contracts';

/** Turns with no person_id at all: heard, not yet separated into a voice. */
export const UNATTRIBUTED_LABEL = 'Unattributed speaker';

export interface SpeakerLabels {
  label(personId?: string): string;
  /** Every distinct label in the scope, in order of first appearance. */
  roster(): string[];
}

function displayName(person: Person | undefined): string | undefined {
  if (!person || person.is_unnamed) return undefined;
  const name = person.name?.trim();
  return name ? name : undefined;
}

/**
 * Label every speaker appearing in these turns.
 *
 * Named people get their name; the owner gets "You", because the answer is
 * spoken back to them. Unnamed voices get a stable number in order of first
 * appearance, so the same voice reads as the same speaker everywhere in one
 * answer.
 */
export function labelSpeakers(
  utterances: Array<{ person_id?: string }>,
  people: Person[],
): SpeakerLabels {
  const byId = new Map(people.map((person) => [person._id, person]));
  const labels = new Map<string, string>();
  const order: string[] = [];
  let unnamedSeen = 0;

  for (const utterance of utterances) {
    const key = utterance.person_id ?? '';
    if (labels.has(key)) continue;

    let label: string;
    if (!utterance.person_id) {
      label = UNATTRIBUTED_LABEL;
    } else {
      const person = byId.get(utterance.person_id);
      const name = displayName(person);
      if (person?.is_owner) label = 'You';
      else if (name) label = name;
      else {
        unnamedSeen += 1;
        label = `Speaker ${unnamedSeen}`;
      }
    }

    labels.set(key, label);
    order.push(label);
  }

  return {
    label: (personId?: string) => labels.get(personId ?? '') ?? UNATTRIBUTED_LABEL,
    roster: () => order,
  };
}
