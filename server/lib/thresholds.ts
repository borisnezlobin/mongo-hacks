import { ATTRIBUTION_THRESHOLD, OWNER_AUTH_THRESHOLD } from '../../shared/contracts';

/**
 * Both speaker thresholds, in one place, overridable at the venue.
 *
 * These used to be read inline as `Number(process.env.X ?? CONST)`, which has
 * two problems. A typo'd or empty env var parses to NaN, and every comparison
 * against NaN is false — so `confidence >= NaN` silently rejects every speaker
 * and attribution looks broken rather than misconfigured. And with each call
 * site reading its own variable, the relationship between the two thresholds
 * was invisible, which is how they ended up equal.
 */
function fromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    console.warn(`${name}="${raw}" is not a number — using ${fallback}`);
    return fallback;
  }
  return parsed;
}

/** Strict gate: is this turn THIS person, rather than someone who sounds like them? */
export function attributionThreshold(): number {
  return fromEnv('ATTRIBUTION_THRESHOLD', ATTRIBUTION_THRESHOLD);
}

/**
 * Stricter gate: may this voice make Amelia act?
 *
 * `PLAN.md:70` paired 0.75 attribution with 0.60 owner auth and called owner
 * auth the loose one. That ordering made sense when the two mistakes were
 * symmetric — a missed summon is a retry, a wrong attribution is two people
 * merged. It stopped making sense once the agent gained profile-update tools:
 * owner auth is now a WRITE path, and the cost of accepting the wrong voice is
 * a stranger editing the owner's memory, not an awkward pause.
 *
 * So it is the strict one now. A missed summon still has a deliberate bypass —
 * press-and-hold — which is exactly why failing closed here is affordable.
 */
export function ownerAuthThreshold(): number {
  return fromEnv('OWNER_AUTH_THRESHOLD', OWNER_AUTH_THRESHOLD);
}
