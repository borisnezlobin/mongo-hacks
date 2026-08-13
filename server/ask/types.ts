import type { Fact, Id, PromiseMemory, SearchMemoryResult, Timestamp, Utterance } from '../../shared/contracts';

export type PipelineStage = Record<string, unknown>;
export type Filter = Record<string, unknown>;

export interface FactCollection {
  aggregate(pipeline: PipelineStage[]): { toArray(): Promise<Fact[]> };
}

export interface ScanCollection<T> {
  find(filter: Filter): { limit(count: number): { toArray(): Promise<T[]> } };
}

export interface RetrievalCollections {
  facts: FactCollection;
  promises: ScanCollection<PromiseMemory>;
  utterances: ScanCollection<Utterance>;
}

export interface StructuredRequest {
  system: string;
  user: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
}

/**
 * Everything the stages are allowed to reach for. Injecting Atlas, embeddings
 * and the LLM keeps the ranking logic testable without a cluster or a key.
 */
export interface RetrievalDeps {
  collections: RetrievalCollections;
  embedQueries(texts: string[]): Promise<number[][]>;
  complete<T>(request: StructuredRequest): Promise<T>;
}

/**
 * A retrieved item while it is still being ranked. `SearchMemoryResult` is a
 * frozen contract with no room for the attribute and date the reranker needs,
 * so the pipeline carries them internally and projects at the boundary.
 */
export interface Candidate {
  id: Id;
  kind: SearchMemoryResult['kind'];
  text: string;
  score: number;
  person_id?: Id;
  source_utterance_id?: Id;
  attribute?: string;
  stated_at?: Timestamp;
}

export function toSearchResult(candidate: Candidate): SearchMemoryResult {
  return {
    kind: candidate.kind,
    id: candidate.id,
    person_id: candidate.person_id,
    text: candidate.text,
    score: candidate.score,
    source_utterance_id: candidate.source_utterance_id,
  };
}

export function factCandidate(fact: Fact, score = 0): Candidate {
  return {
    id: fact._id,
    kind: 'fact',
    text: fact.claim,
    score,
    person_id: fact.person_id,
    source_utterance_id: fact.primary_source_utterance_id,
    attribute: fact.attribute,
    stated_at: fact.valid_from,
  };
}
