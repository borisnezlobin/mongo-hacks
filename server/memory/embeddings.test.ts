import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./fireworks', () => ({
  fireworksBaseUrl: () => 'https://fireworks.test/v1',
  fireworksKey: () => 'test-key',
}));

import { EMBEDDING_DIMS } from '../../shared/contracts';
import { embedDocuments, embedQuery } from './embeddings';

const VECTOR = Array.from({ length: EMBEDDING_DIMS }, (_, position) => position / EMBEDDING_DIMS);

function ok(count = 1): Response {
  return new Response(
    JSON.stringify({ data: Array.from({ length: count }, (_, index) => ({ embedding: VECTOR, index })) }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function failure(status: number, headers: Record<string, string> = {}): Response {
  return new Response('provider said no', { status, headers });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function run<T>(pending: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return pending;
}

/**
 * Why these matter more than they look: a question whose embedding call fails
 * is answered from words alone, which changes which facts retrieval returns and
 * therefore whether `/ask` answers from search results or from an assembled
 * view of the whole conversation. Losing the call is not a worse answer, it is
 * a different one, and the only trace it leaves is a warning line.
 */
describe('an embedding call the provider refused once', () => {
  it('rides out an overloaded backend rather than answering lexically', async () => {
    fetchMock.mockResolvedValueOnce(failure(503)).mockResolvedValueOnce(ok());

    await expect(run(embedQuery('what did we talk about'))).resolves.toEqual(VECTOR);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rides out a rate limit', async () => {
    fetchMock.mockResolvedValueOnce(failure(429)).mockResolvedValueOnce(ok());

    await expect(run(embedQuery('who is from Turkey'))).resolves.toEqual(VECTOR);
  });

  it('retries a dropped connection', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('network error')).mockResolvedValueOnce(ok());

    await expect(run(embedQuery('who is from Turkey'))).resolves.toEqual(VECTOR);
  });

  it('waits the interval the provider asked for', async () => {
    fetchMock
      .mockResolvedValueOnce(failure(429, { 'retry-after': '2' }))
      .mockResolvedValueOnce(ok());
    const pending = embedQuery('who is from Turkey');

    await vi.advanceTimersByTimeAsync(1_500);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(pending).resolves.toEqual(VECTOR);
  });

  it('gives up after a bounded number of attempts rather than queuing forever', async () => {
    fetchMock.mockImplementation(async () => failure(503));
    const settled = embedQuery('who is from Turkey').catch((error: unknown) => error);
    await vi.runAllTimersAsync();

    expect(String(await settled)).toMatch(/503/);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('does not retry a request the provider will reject again', async () => {
    fetchMock.mockImplementation(async () => failure(401));
    const settled = embedQuery('who is from Turkey').catch((error: unknown) => error);
    await vi.runAllTimersAsync();

    expect(String(await settled)).toMatch(/401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a batch of documents the same way', async () => {
    fetchMock.mockResolvedValueOnce(failure(502)).mockResolvedValueOnce(ok(3));

    const vectors = await run(embedDocuments(['a', 'b', 'c']));
    expect(vectors).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not call the provider at all for an empty batch', async () => {
    await expect(embedDocuments([])).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
