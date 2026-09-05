import { describe, expect, it } from 'vitest';
import { formatAgo } from './format';

const NOW = new Date('2026-03-01T12:00:00.000Z').getTime();
const ago = (ms: number) => formatAgo(new Date(NOW - ms).toISOString(), NOW);

describe('formatAgo', () => {
  it('rounds to the words a caption would use', () => {
    expect(ago(5_000)).toBe('just now');
    expect(ago(5 * 60_000)).toBe('5 minutes ago');
    expect(ago(60_000)).toBe('1 minute ago');
    expect(ago(3 * 3_600_000)).toBe('3 hours ago');
    expect(ago(30 * 3_600_000)).toBe('yesterday');
    expect(ago(4 * 86_400_000)).toBe('4 days ago');
    expect(ago(21 * 86_400_000)).toBe('3 weeks ago');
    expect(ago(70 * 86_400_000)).toBe('2 months ago');
    expect(ago(800 * 86_400_000)).toBe('2 years ago');
  });

  it('says nothing when there is nothing to say', () => {
    expect(formatAgo(undefined, NOW)).toBe('');
    expect(formatAgo('not a date', NOW)).toBe('');
  });
});
