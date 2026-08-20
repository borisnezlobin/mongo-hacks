/**
 * Re-embed facts that were stored while the embedding provider was down.
 *
 *   npx tsx db/backfill-embeddings.mts
 *
 * `recordFact` keeps the fact and marks the row rather than dropping the claim,
 * so this is the repair step that makes those facts searchable again.
 */
import { backfillFactEmbeddings } from '../server/memory/store';
import { closeDb, initStorage } from '../server/memory/db';

const health = await initStorage();
console.log(`storage: ${health.driver}${health.degraded ? ' (Atlas unreachable)' : ''}`);

const result = await backfillFactEmbeddings();
console.log(`facts missing an embedding: ${result.pending}`);
console.log(`embedded: ${result.embedded}, still failing: ${result.failed}`);
if (result.failed > 0) process.exitCode = 1;

await closeDb();
