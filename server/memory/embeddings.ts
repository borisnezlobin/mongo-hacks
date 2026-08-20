import { EMBEDDING_DIMS, EMBEDDING_MODEL } from '../../shared/contracts';
import { fireworksBaseUrl, fireworksKey } from './fireworks';
import { providerFailure, RetryableProviderError, withProviderRetry } from './retry';

/**
 * Nomic's embedding models are trained with task prefixes: a stored fact and a
 * question about it get different ones, and dropping them measurably degrades
 * retrieval. They are part of the input, not decoration.
 */
const PREFIX = { document: 'search_document: ', query: 'search_query: ' } as const;

/**
 * One attempt at the provider. Retrying is the caller's job, and it is not
 * optional: a question whose embedding call fails is answered lexically, which
 * changes what retrieval finds and therefore how the whole answer is composed.
 * A blip here is not a slightly worse answer, it is a different one.
 */
async function requestEmbeddings(texts: string[], inputType: keyof typeof PREFIX): Promise<number[][]> {
  let response: Response;
  try {
    response = await fetch(`${fireworksBaseUrl()}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${fireworksKey()}` },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: texts.map((text) => `${PREFIX[inputType]}${text}`),
        dimensions: EMBEDDING_DIMS,
      }),
    });
  } catch (error) {
    // A dropped connection is indistinguishable from an overloaded backend
    // from here, and both are worth another attempt.
    throw new RetryableProviderError(`Fireworks embedding failed to connect: ${String(error)}`);
  }

  if (!response.ok) {
    const detail = `Fireworks embedding failed: ${response.status} ${await response.text()}`;
    throw providerFailure(response.status, detail, response.headers);
  }

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

async function embedBatch(texts: string[], inputType: keyof typeof PREFIX): Promise<number[][]> {
  return withProviderRetry(() => requestEmbeddings(texts, inputType));
}

export async function embedDocuments(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  return embedBatch(texts, 'document');
}

export async function embedQuery(text: string): Promise<number[]> {
  const [embedding] = await embedBatch([text], 'query');
  return embedding;
}
