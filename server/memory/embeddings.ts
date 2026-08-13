import { VOYAGE_DIMS, VOYAGE_MODEL } from '../../shared/contracts';

const ENDPOINT = 'https://api.voyageai.com/v1/embeddings';

/**
 * Model and dimensions are pinned in contracts and already baked into the
 * applied Atlas vector index — changing either one invalidates facts_vector.
 */
async function embedBatch(texts: string[], inputType: 'document' | 'query'): Promise<number[][]> {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) throw new Error('VOYAGE_API_KEY is required for fact embeddings');

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ input: texts, model: VOYAGE_MODEL, input_type: inputType, output_dimension: VOYAGE_DIMS }),
  });
  if (!response.ok) throw new Error(`Voyage embedding failed: ${response.status} ${await response.text()}`);

  const payload = (await response.json()) as { data: Array<{ embedding: number[]; index: number }> };
  const ordered = [...payload.data].sort((a, b) => a.index - b.index).map((item) => item.embedding);
  const wrongDims = ordered.find((embedding) => embedding.length !== VOYAGE_DIMS);
  if (wrongDims) throw new Error(`Voyage returned ${wrongDims.length} dims, index expects ${VOYAGE_DIMS}`);
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
