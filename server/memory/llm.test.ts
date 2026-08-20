import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./fireworks', () => ({
  fireworksBaseUrl: () => 'https://fireworks.test/v1',
  fireworksKey: () => 'test-key',
}));

import { extractStructured, parseSalvageable } from './llm';

const SCHEMA = { type: 'object', additionalProperties: false, required: [], properties: {} };

function ok(body: unknown): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(body) }, finish_reason: 'stop' }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function overloaded(headers: Record<string, string> = {}): Response {
  return new Response('service overloaded', { status: 503, headers });
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

async function run<T>(): Promise<T> {
  const pending = extractStructured<T>({ system: 's', user: 'u', schema: SCHEMA });
  await vi.runAllTimersAsync();
  return pending;
}

describe('provider overload', () => {
  it('rides out a 503 instead of losing the window', async () => {
    fetchMock.mockResolvedValueOnce(overloaded()).mockResolvedValueOnce(ok({ facts: [] }));

    await expect(run()).resolves.toEqual({ facts: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a dropped connection', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('network error')).mockResolvedValueOnce(ok({ facts: [] }));

    await expect(run()).resolves.toEqual({ facts: [] });
  });

  it('gives up after a bounded number of attempts rather than queuing forever', async () => {
    fetchMock.mockImplementation(async () => overloaded());

    await expect(run()).rejects.toThrow(/503/);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('honours Retry-After', async () => {
    fetchMock.mockResolvedValueOnce(overloaded({ 'retry-after': '2' })).mockResolvedValueOnce(ok({ facts: [] }));

    const pending = extractStructured({ system: 's', user: 'u', schema: SCHEMA });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(pending).resolves.toEqual({ facts: [] });
  });

  it('does not retry a request the provider will reject again', async () => {
    fetchMock.mockImplementation(async () => new Response('bad schema', { status: 400 }));

    await expect(run()).rejects.toThrow(/400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails loudly on a truncated reply rather than writing half a fact', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"facts": [' }, finish_reason: 'length' }],
    }), { status: 200 }));

    await expect(run()).rejects.toThrow(/token cap/);
  });
});

describe('a reply cut off by the token cap', () => {
  function truncated(content: string): Response {
    return new Response(
      JSON.stringify({ choices: [{ message: { content }, finish_reason: 'length' }] }),
      { status: 200 },
    );
  }

  async function salvage<T>(content: string): Promise<T> {
    fetchMock.mockImplementation(async () => truncated(content));
    const pending = extractStructured<T>({
      system: 's',
      user: 'u',
      schema: SCHEMA,
      salvageTruncated: parseSalvageable,
    });
    await vi.runAllTimersAsync();
    return pending;
  }

  it('keeps the fields that finished when the caller asked to salvage', async () => {
    await expect(
      salvage('{"answer":"Boris is studying applied math.","cited_ids":["fact-1","fact-2'),
    ).resolves.toEqual({ answer: 'Boris is studying applied math.', cited_ids: ['fact-1'] });
  });

  it('never closes a sentence the model was still writing', async () => {
    await expect(salvage('{"answer":"Boris is studying app')).resolves.toEqual({});
  });

  it('carries the partial reply on the error when nothing survives', async () => {
    fetchMock.mockImplementation(async () => truncated('not json at all'));
    const settled = extractStructured({
      system: 's',
      user: 'u',
      schema: SCHEMA,
      salvageTruncated: parseSalvageable,
    }).catch((error: unknown) => error);
    await vi.runAllTimersAsync();

    expect(await settled).toMatchObject({ name: 'TokenCapError', partial: 'not json at all' });
  });
});

describe('reasoning effort', () => {
  it('is sent only when the caller chose one', async () => {
    fetchMock.mockResolvedValueOnce(ok({})).mockResolvedValueOnce(ok({}));

    await extractStructured({ system: 's', user: 'u', schema: SCHEMA });
    await extractStructured({ system: 's', user: 'u', schema: SCHEMA, reasoningEffort: 'low' });

    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(call[1].body));
    expect(bodies[0].reasoning_effort).toBeUndefined();
    expect(bodies[1].reasoning_effort).toBe('low');
  });
});
