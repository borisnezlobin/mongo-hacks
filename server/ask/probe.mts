/**
 * Exercises the multi-stage retrieval pipeline against the live cluster and
 * prints what each stage did, then reruns the same question with the LLM stages
 * off so the two rankings can be compared side by side.
 *
 *   npx tsx server/ask/probe.mts "what is Sarah's coffee order"
 *   npx tsx server/ask/probe.mts --person <person_id> "what did they promise"
 *
 * Needs MONGODB_URI and FIREWORKS_API_KEY. Read-only: it runs queries and
 * writes nothing.
 */
import type { Id, SearchMemoryResult } from '../../shared/contracts';
import { closeDb, collections } from '../memory/db';
import { embedQueries } from '../memory/embeddings';
import { loadEnv } from '../memory/env';
import { extractStructured } from '../memory/llm';
import { hybridFactSearch, scanPromisesAndUtterances } from './candidates';
import { retrievalConfig } from './config';
import { keywordsFrom, planQuery } from './query-plan';
import { searchMemory } from './retrieval';
import type { Candidate, Filter, RetrievalDeps } from './types';

const argv = process.argv.slice(2);
const personFlag = argv.indexOf('--person');
const personId: Id | undefined = personFlag === -1 ? undefined : argv[personFlag + 1];
const query = argv
  .filter((_arg, index) => personFlag === -1 || (index !== personFlag && index !== personFlag + 1))
  .join(' ')
  .trim();

if (!query) {
  console.error('usage: npx tsx server/ask/probe.mts [--person <id>] "<question>"');
  process.exit(1);
}

const deps: RetrievalDeps = {
  collections: {
    facts: { aggregate: (pipeline) => collections.facts().aggregate(pipeline) },
    promises: {
      find: (filter: Filter) =>
        collections.promises().find(filter as Parameters<ReturnType<typeof collections.promises>['find']>[0]),
    },
    utterances: {
      find: (filter: Filter) =>
        collections.utterances().find(filter as Parameters<ReturnType<typeof collections.utterances>['find']>[0]),
    },
  },
  embedQueries,
  complete: extractStructured,
};

function preview(text: string, width = 72): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= width ? flat : `${flat.slice(0, width - 1)}…`;
}

function printResults(results: SearchMemoryResult[]): void {
  if (results.length === 0) {
    console.log('  (nothing)');
    return;
  }
  results.forEach((result, index) => {
    console.log(`  ${index + 1}. [${result.score.toFixed(3)}] ${result.kind.padEnd(9)} ${preview(result.text)}`);
  });
}

/** Positional movement between the two runs is the clearest read on what reranking bought. */
function printMovement(baseline: SearchMemoryResult[], full: SearchMemoryResult[]): void {
  const before = new Map(baseline.map((result, index) => [result.id, index + 1]));
  full.forEach((result, index) => {
    const was = before.get(result.id);
    const move = was === undefined ? 'new' : was === index + 1 ? 'same' : `${was} -> ${index + 1}`;
    console.log(`  ${String(index + 1).padStart(2)}. ${move.padEnd(10)} ${preview(result.text, 60)}`);
  });
  const dropped = baseline.filter((result) => !full.some((kept) => kept.id === result.id));
  for (const result of dropped) {
    console.log(`  --  dropped    ${preview(result.text, 60)}`);
  }
}

async function main(): Promise<void> {
  const envFiles = loadEnv();
  console.log(`env files read   : ${envFiles.length > 0 ? envFiles.join(', ') : 'none (ambient environment)'}`);
  console.log(`MONGODB_URI      : ${process.env.MONGODB_URI ? 'set' : 'MISSING'}`);
  console.log(`FIREWORKS_API_KEY: ${process.env.FIREWORKS_API_KEY ? 'set' : 'MISSING'}`);
  console.log(`question         : ${query}`);
  console.log(`person filter    : ${personId ?? 'none'}`);

  const liveFacts = await collections.facts().countDocuments({ superseded_by: { $in: [null, undefined] } });
  console.log(`live facts       : ${liveFacts}`);
  if (liveFacts === 0) console.log('  (no facts stored yet — run the fixture replay first or this proves little)');

  const config = retrievalConfig();
  console.log(
    `\nconfig           : plan=${config.plan} rerank=${config.rerank} rankFusion=${config.rankFusion} ` +
      `variants=${config.maxVariants} pool=${config.rerankPool} limit=${config.limit}`,
  );

  console.log(`\n— stage 1: query plan ${config.plan ? '' : '(off — set ASK_QUERY_PLANNING=1) '}—`);
  const planStarted = Date.now();
  const plan = await planQuery(query, deps, config);
  console.log(`  ${Date.now() - planStarted} ms`);
  console.log(`  variants     : ${plan.variants.length > 0 ? plan.variants.join(' | ') : '(none)'}`);
  console.log(`  hypothetical : ${plan.hypothetical ?? '(none)'}`);
  console.log(`  keywords     : ${keywordsFrom(query).join(', ') || '(none)'} (derived locally, not from the planner)`);

  console.log('\n— stage 2: recall per formulation —');
  const formulations = [query, ...(plan.hypothetical ? [plan.hypothetical] : []), ...plan.variants];
  const embeddings = await embedQueries(formulations);
  const perLeg: Candidate[][] = [];
  for (const [index, text] of formulations.entries()) {
    const started = Date.now();
    const hits = await hybridFactSearch(deps, config, text, embeddings[index]!, personId);
    perLeg.push(hits);
    console.log(`  ${String(hits.length).padStart(3)} facts in ${String(Date.now() - started).padStart(5)} ms  "${preview(text, 56)}"`);
  }
  const scanned = await scanPromisesAndUtterances(deps, config, keywordsFrom(query), personId);
  console.log(`  ${String(scanned.length).padStart(3)} promises/utterances from the keyword scan`);

  const unionSize = new Set(perLeg.flat().map((candidate) => candidate.id)).size;
  const originalSize = new Set(perLeg[0]!.map((candidate) => candidate.id)).size;
  console.log(`  union across formulations: ${unionSize} facts (the question alone found ${originalSize})`);

  console.log('\n— full pipeline —');
  const fullStarted = Date.now();
  const full = await searchMemory(query, personId, { deps });
  const fullMs = Date.now() - fullStarted;
  printResults(full);
  console.log(`  ${fullMs} ms end to end`);

  console.log('\n— baseline: single hybrid search, no planning, no reranking —');
  const baselineStarted = Date.now();
  const baseline = await searchMemory(query, personId, { deps, config: { plan: false, rerank: false } });
  const baselineMs = Date.now() - baselineStarted;
  printResults(baseline);
  console.log(`  ${baselineMs} ms end to end`);

  console.log(`\n— what the extra stages changed (+${fullMs - baselineMs} ms) —`);
  printMovement(baseline, full);
}

main()
  .catch((error) => {
    console.error(`\nprobe failed: ${(error as Error).message}`);
    process.exitCode = 1;
  })
  .finally(closeDb);
