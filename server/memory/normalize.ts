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
