/**
 * Durations, in one place, with the unit in the name.
 *
 * There were two helpers called `clock` in the page script — one taking
 * milliseconds and one taking seconds. Function declarations hoist, so the
 * second silently won every call site and the speaker picker rendered
 * "12562m10s" for a voice in a 48-minute recording. Nothing failed; it just
 * printed a number 60,000 times too large next to a real one.
 *
 * The names now carry the unit, there is exactly one of each, and the page gets
 * its copy from here rather than declaring its own, so the two cannot drift.
 */

export function msToClock(ms: number): string {
  const total = Math.round(ms / 1000);
  if (!Number.isFinite(total) || total < 0) return '0s';
  return total >= 60
    ? `${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}s`
    : `${total}s`;
}

export function secondsToClock(seconds: number): string {
  const total = Math.round(seconds);
  if (!Number.isFinite(total) || total < 0) return '0s';
  return total >= 60
    ? `${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}s`
    : `${total}s`;
}

/**
 * The same two functions as browser source, injected into the page.
 *
 * Serialising them is what makes "one implementation" true rather than a
 * comment asking future edits to keep two copies in step.
 */
export function durationHelpersSource(): string {
  return [`const msToClock = ${msToClock.toString()};`, `const secondsToClock = ${secondsToClock.toString()};`].join('\n');
}
