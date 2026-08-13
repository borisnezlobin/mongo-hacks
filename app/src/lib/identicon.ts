/**
 * Deterministic avatars keyed off the voiceprint id, so a speaker looks the same before
 * and after they get a name. That persistence is the whole point of the naming moment:
 * the face stays put, the name attaches to it.
 */

function hash(seed: string): number {
  let value = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    value ^= seed.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

/** Warm, paper-friendly hues only — nothing that fights the cream canvas. */
const HUES = [18, 32, 44, 96, 152, 196, 258, 330];

export interface Identicon {
  background: string;
  ink: string;
  /** Row-major 5x5 grid, mirrored horizontally, true where a dot is drawn. */
  cells: boolean[];
}

export function identiconFor(seed: string): Identicon {
  const seedHash = hash(seed || 'unknown');
  const hue = HUES[seedHash % HUES.length];
  const background = `hsl(${hue}, 46%, 92%)`;
  const ink = `hsl(${hue}, 44%, 42%)`;

  const cells: boolean[] = new Array(25).fill(false);
  for (let row = 0; row < 5; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      const bit = (seedHash >> ((row * 3 + column) % 29)) & 1;
      const on = bit === 1;
      cells[row * 5 + column] = on;
      cells[row * 5 + (4 - column)] = on;
    }
  }
  return { background, ink, cells };
}

export function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
