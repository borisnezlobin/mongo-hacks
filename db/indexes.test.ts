import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { VOYAGE_DIMS } from '../shared/contracts';

describe('Atlas index bootstrap', () => {
  it('uses the complete three-index allowance with the frozen Voyage dimensions', async () => {
    const config = JSON.parse(await readFile(new URL('./indexes.json', import.meta.url), 'utf8'));
    expect(config.searchIndexes).toHaveLength(3);
    expect(config.searchIndexes.filter((index: { type: string }) => index.type === 'vectorSearch')).toHaveLength(2);
    expect(config.searchIndexes.filter((index: { type: string }) => index.type === 'search')).toHaveLength(1);
    for (const index of config.searchIndexes.filter((item: { type: string }) => item.type === 'vectorSearch')) {
      expect(index.definition.fields[0].numDimensions).toBe(VOYAGE_DIMS);
    }
  });

  it('declares the frozen idempotency keys', async () => {
    const config = JSON.parse(await readFile(new URL('./indexes.json', import.meta.url), 'utf8'));
    const unique = config.collectionIndexes.filter((index: { options: { unique?: boolean } }) => index.options.unique);
    expect(unique.map((index: { options: { name: string } }) => index.options.name)).toEqual([
      'facts_idempotency',
      'promises_idempotency',
    ]);
  });
});
