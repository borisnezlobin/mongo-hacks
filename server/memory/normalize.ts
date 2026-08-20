import { TONIGHT_DEFAULT_HOUR } from '../../shared/contracts';

/**
 * Feeds the unique idempotency indexes on facts and promises: two extractions of
 * the same sentence must collide, so casing, punctuation and spacing are stripped.
 */
export function normalizeClaim(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const normalizePromiseText = normalizeClaim;

/**
 * The one place the fact attribute vocabulary is defined.
 *
 * An attribute is a *slot*: two claims share one exactly when the newer can
 * replace the older, which is what supersession keys on. There used to be two
 * competing spellings of that vocabulary — extraction advertised short keys
 * while seeded data used descriptive ones — held together by a hand-maintained
 * bidirectional alias map that had to grow by two entries for every new slot.
 * Now there is a single canonical list, every other spelling is declared as a
 * legacy synonym of one of them, and both canonicalisation and alias lookup are
 * derived from that declaration.
 *
 * The slots are the generic ones a person profile has — where somebody is from,
 * what they study, what they do, who they are to you. None of them is drawn
 * from any particular conversation's subject matter, and adding one because a
 * single recording happened to be about something is how this list stops
 * generalising.
 */
export const FACT_ATTRIBUTES = [
  'name',
  /** Where they are from. */
  'origin',
  /** Where they live or are based now. */
  'location',
  /** A relocation, planned or completed. */
  'move',
  /** The school or university they attend. */
  'school',
  /** Field of study, major, programme. */
  'study',
  /** Year or stage of study. */
  'academic_year',
  'job',
  'employer',
  /** Something they are building, running or working on. */
  'project',
  /** A club, team, society or organisation they belong to. */
  'affiliation',
  /** Something they like or dislike. */
  'preference',
  /** How they relate to the owner or to another person. */
  'relationship',
  'family',
  'health',
  'travel',
  /** A language they speak. */
  'language',
  /**
   * A durable fact that fits none of the slots above.
   *
   * Reachable by `addNote`, where a human decided the thing was worth keeping,
   * and NOT offered to the extractor — see EXTRACTABLE_FACT_ATTRIBUTES.
   */
  'note',
] as const;

export type FactAttribute = (typeof FACT_ATTRIBUTES)[number];

/**
 * The slots extraction is allowed to fill.
 *
 * `note` is deliberately absent. Replaying a real 48-minute conversation with
 * it in the enum, 42% of everything extracted landed there, and most of that
 * was not durable at all: who was holding a toothbrush, who had been on the
 * floor since 9am, who had not memorised their student ID. A free slot is
 * where a model puts anything it cannot classify, so offering one converts
 * "this is not a fact" into "this is a note". Without it the model has to
 * name the kind of thing it found, and if it cannot, nothing is written —
 * which is the trade this product wants.
 *
 * Removing it took that recording from 105 facts to 64, and hand-checking
 * every one of the survivors put precision at 83%. If you are about to add it
 * back to improve recall: the recall it adds is almost entirely toothbrushes.
 * Add a real slot for the thing you are missing instead.
 */
export const EXTRACTABLE_FACT_ATTRIBUTES = FACT_ATTRIBUTES.filter(
  (attribute) => attribute !== 'note',
);

const CANONICAL = new Set<string>(FACT_ATTRIBUTES);

/** Spellings written by earlier extractors, seeded demo data, or the model. */
const LEGACY_ATTRIBUTE_SPELLINGS: Record<string, FactAttribute> = {
  move_date: 'move',
  food_preference: 'preference',
  music_preference: 'preference',
  work: 'job',
  occupation: 'job',
  company: 'employer',
  recent_trip: 'travel',
  hometown: 'origin',
  university: 'school',
  college: 'school',
  major: 'study',
  field_of_study: 'study',
  year: 'academic_year',
  class_year: 'academic_year',
};

const ALIASES_BY_CANONICAL = new Map<string, string[]>(
  FACT_ATTRIBUTES.map((canonical) => [canonical, [canonical as string]]),
);
for (const [legacy, canonical] of Object.entries(LEGACY_ATTRIBUTE_SPELLINGS)) {
  ALIASES_BY_CANONICAL.get(canonical)?.push(legacy);
}

/**
 * The slot a claim actually occupies, whatever the writer called it. Unknown
 * attributes pass through unchanged rather than being forced into `note`, so a
 * row written by another lane is still findable under its own name.
 */
export function canonicalFactAttribute(attribute: string): string {
  const key = attribute.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (CANONICAL.has(key)) return key;
  return LEGACY_ATTRIBUTE_SPELLINGS[key] ?? key;
}

/** Every spelling a stored fact in this slot might have been written under. */
export function factAttributeAliases(attribute: string): string[] {
  const canonical = canonicalFactAttribute(attribute);
  const group = ALIASES_BY_CANONICAL.get(canonical);
  if (!group || group.length === 1) return [attribute];
  return group;
}

/** "hey amelia", "Hey, Amelia!" and "HEY AMELIA" are the same wake phrase. */
export function containsPhrase(text: string, phrase: string): boolean {
  return normalizeClaim(text).includes(normalizeClaim(phrase));
}

/**
 * The extraction model resolves relative dates against today and returns ISO,
 * but "tonight" is pinned to a constant so the demo reminder is predictable.
 */
export function resolveTonight(reference = new Date()): string {
  const tonight = new Date(reference);
  tonight.setHours(TONIGHT_DEFAULT_HOUR, 0, 0, 0);
  if (tonight <= reference) tonight.setDate(tonight.getDate() + 1);
  return tonight.toISOString();
}

export function todayIsoDate(reference = new Date()): string {
  return reference.toISOString().slice(0, 10);
}
