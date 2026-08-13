import { EMBEDDING_DIMS, EMBEDDING_MODEL } from '../../shared/contracts';
import { fireworksBaseUrl, fireworksKey } from './fireworks';

/**
 * Nomic's embedding models are trained with task prefixes: a stored fact and a
 * question about it get different ones, and dropping them measurably degrades
 * retrieval. They are part of the input, not decoration.
 */
const PREFIX = { document: 'search_document: ', query: 'search_query: ' } as const;

async function embedBatch(texts: string[], inputType: keyof typeof PREFIX): Promise<number[][]> {
  const response = await fetch(`${fireworksBaseUrl()}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${fireworksKey()}` },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: texts.map((text) => `${PREFIX[inputType]}${text}`),
      dimensions: EMBEDDING_DIMS,
    }),
  });
  if (!response.ok) throw new Error(`Fireworks embedding failed: ${response.status} ${await response.text()}`);

  const payload = (await response.json()) as { data: Array<{ embedding: number[]; index: number }> };
  const ordered = [...payload.data].sort((a, b) => a.index - b.index).map((item) => item.embedding);

  // The vector index is fixed at EMBEDDING_DIMS; a silent mismatch would write
  // rows that $vectorSearch can never return.
  const wrongDims = ordered.find((embedding) => embedding.length !== EMBEDDING_DIMS);
  if (wrongDims) {
    throw new Error(
      `${EMBEDDING_MODEL} returned ${wrongDims.length} dims but the index expects ${EMBEDDING_DIMS}`,
    );
  }
  return ordered;
}

export async function embedDocuments(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  return embedBatch(texts, 'document');
}

export async function embedQuery(text: string): Promise<number[]> {
  const [embedding] = await embedBatch([text], 'query');
  return embedding;
}
