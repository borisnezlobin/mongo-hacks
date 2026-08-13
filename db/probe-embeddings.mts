/**
 * Run this BEFORE apply-indexes.mjs.
 *
 * The facts vector index is created with EMBEDDING_DIMS baked in, and the
 * sandbox's three-index cap means it cannot be recreated cheaply. This asks the
 * live Fireworks model what it actually returns and fails loudly on a mismatch,
 * so a wrong constant costs a rerun rather than the index budget.
 *
 *   npx tsx db/probe-embeddings.ts
 */
import { EMBEDDING_DIMS, EMBEDDING_MODEL, EXTRACTION_MODEL } from '../shared/contracts';
import { embedDocuments, embedQuery } from '../server/memory/embeddings';
import { extractStructured } from '../server/memory/llm';

async function probeEmbeddings(): Promise<boolean> {
  console.log(`embedding model : ${EMBEDDING_MODEL}`);
  try {
    const [document] = await embedDocuments(['Maya moves to Oakland on September fifteenth.']);
    const query = await embedQuery('When is Maya moving?');
    console.log(`  dimensions    : ${document.length} (contract says ${EMBEDDING_DIMS})`);
    console.log(`  query vector  : ${query.length}`);
    return true;
  } catch (error) {
    // embedDocuments already fails on a dimension mismatch; surface its message.
    console.error(`  FAILED        : ${(error as Error).message}`);
    return false;
  }
}

async function probeExtraction(): Promise<boolean> {
  console.log(`extraction model: ${EXTRACTION_MODEL}`);
  try {
    const result = await extractStructured<{ speaker: string; moves_on: string }>({
      system: 'Extract the speaker and the date they move. Return ISO 8601 for the date.',
      user: 'Maya said: "I move to Oakland on September fifteenth, 2026."',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['speaker', 'moves_on'],
        properties: { speaker: { type: 'string' }, moves_on: { type: 'string' } },
      },
      maxTokens: 200,
    });
    console.log(`  structured out: ${JSON.stringify(result)}`);
    return true;
  } catch (error) {
    console.error(`  FAILED        : ${(error as Error).message}`);
    return false;
  }
}

const ok = [await probeEmbeddings(), await probeExtraction()].every(Boolean);
console.log(
  ok
    ? '\nFireworks reachable and dimensions agree — safe to run db/apply-indexes.mjs'
    : `\nDo NOT apply indexes yet. If the model returned a different dimension, set EMBEDDING_DIMS in shared/contracts.ts to that number and rerun.`,
);
if (!ok) process.exitCode = 1;
