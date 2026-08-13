import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { EMBEDDING_DIMS, VOICEPRINT_DIMS } from '../shared/contracts';

interface SearchIndexSpec {
  collection: string;
  name: string;
  type: string;
  definition: { fields?: Array<{ numDimensions?: number }> };
}

const loadConfig = async () =>
  JSON.parse(await readFile(new URL('./indexes.json', import.meta.url), 'utf8'));

describe('Atlas index bootstrap', () => {
  it('spends the three-index allowance on attribution, fact vectors, and fact lexical search', async () => {
    const config = await loadConfig();
    const indexes: SearchIndexSpec[] = config.searchIndexes;
    expect(indexes).toHaveLength(config.searchIndexCap);
    expect(indexes.map((index) => `${index.collection}.${index.name}`)).toEqual([
      'voiceprints.voiceprints_vector',
      'facts.facts_vector',
      'facts.facts_text',
    ]);
  });

  it('pins each vector index to the dimensions of the model that writes it', async () => {
    const config = await loadConfig();
    const dims = Object.fromEntries(
      (config.searchIndexes as SearchIndexSpec[])
        .filter((index) => index.type === 'vectorSearch')
        .map((index) => [index.collection, index.definition.fields?.[0]?.numDimensions]),
    );
    expect(dims).toEqual({ voiceprints: VOICEPRINT_DIMS, facts: EMBEDDING_DIMS });
  });

  it('declares the frozen idempotency keys', async () => {
    const config = await loadConfig();
    const unique = config.collectionIndexes.filter((index: { options: { unique?: boolean } }) => index.options.unique);
    expect(unique.map((index: { options: { name: string } }) => index.options.name)).toEqual([
      'facts_idempotency',
      'promises_idempotency',
    ]);
  });
});
