import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OWNER_ID, type Id } from '../../shared/contracts';
import { closeStorage, createLocalDriver, useStorage, type LocalDriver } from '../storage';

const embeddings = vi.hoisted(() => ({ embedDocuments: vi.fn(), embedQuery: vi.fn() }));
vi.mock('../memory/embeddings', () => embeddings);

import {
  answerQuestion,
  ANSWER_CUT_SHORT,
  askRequestProblem,
  groundAnswer,
  NOTHING_IN_MEMORY,
  questionBreadth,
} from './index';
import { TokenCapError } from '../memory/llm';
import { collections } from '../memory/db';

let dataDir: string;
let driver: LocalDriver;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'amelia-ask-'));
  driver = await createLocalDriver({ dataDir, fsync: false });
  useStorage(driver);
  embeddings.embedQuery.mockRejectedValue(new Error('embeddings offline in tests'));
  embeddings.embedDocuments.mockRejectedValue(new Error('embeddings offline in tests'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeStorage();
  await rm(dataDir, { recursive: true, force: true });
});

describe('reading how broad a question is', () => {
  it('treats a question with no searchable words as one about a whole scope', () => {
    // Breadth follows the evidence, not the wording: a question retrieval could
    // not rank needs coverage of the scope, whatever its length.
    expect(questionBreadth(0)).toBe('overview');
    expect(questionBreadth(1)).toBe('overview');
  });

  it('treats a question with real terms in it as a specific one', () => {
    expect(questionBreadth(3)).toBe('detail');
    expect(questionBreadth(20)).toBe('detail');
  });

  it('counts matched facts, so turns full of the asker’s words do not read as specific', async () => {
    for (let position = 0; position < 6; position += 1) {
      await collections.utterances().insertOne({
        _id: `u-talk-${position}`,
        owner_id: OWNER_ID,
        conversation_id: 'c-talk',
        person_id: 'p-mert',
        text: 'we should talk about that again some time',
        start_ms: position * 1_000,
        end_ms: position * 1_000 + 900,
        is_final: true,
        created_at: 'now',
        updated_at: 'now',
      });
    }

    let granularity = '';
    await answerQuestion(
      { query: 'what did we talk about' },
      {
        extract: async (request) => {
          granularity = request.user.includes('Assembled context') ? 'overview' : 'detail';
          return { answer: 'You talked about meeting again.', cited_ids: ['u-talk-0'] } as never;
        },
      },
    );

    expect(granularity).toBe('overview');
  });
});

describe('grounding an answer in what was retrieved', () => {
  const citable = new Set(['u-1', 'f-2']);

  it('keeps an answer that cites something real', () => {
    const grounded = groundAnswer('Mert is building a freight startup.', ['u-1'], citable);
    expect(grounded).toMatchObject({ text: 'Mert is building a freight startup.', grounded: true });
  });

  it('drops citations that point at nothing', () => {
    const grounded = groundAnswer('He mentioned Istanbul.', ['u-1', 'u-invented'], citable);
    expect([...grounded.cited]).toEqual(['u-1']);
  });

  it('refuses an answer whose every citation was invented', () => {
    const grounded = groundAnswer('Mert has three sisters in Ankara.', ['u-999'], citable);
    expect(grounded.text).toBe(NOTHING_IN_MEMORY);
    expect(grounded.grounded).toBe(false);
  });

  it('refuses an answer with no citations at all', () => {
    const grounded = groundAnswer('Probably something about the dorm.', [], citable);
    expect(grounded.text).toBe(NOTHING_IN_MEMORY);
  });
});

describe('answering', () => {
  beforeEach(async () => {
    await collections
      .conversations()
      .insertOne({ _id: 'c1', owner_id: OWNER_ID, started_at: '2026-08-01T20:00:00.000Z', participant_ids: ['p-mert'] });
    await collections
      .people()
      .insertOne({ _id: 'p-mert', owner_id: OWNER_ID, name: 'Mert', created_at: 'now', updated_at: 'now' });
    await collections.utterances().insertOne({
      _id: 'u-1',
      owner_id: OWNER_ID,
      conversation_id: 'c1',
      person_id: 'p-mert',
      text: 'I am building a freight logistics startup with two pilot customers',
      start_ms: 0,
      end_ms: 4_000,
      is_final: true,
      created_at: 'now',
      updated_at: 'now',
    });
  });

  it('answers from retrieved material and cites it', async () => {
    const response = await answerQuestion(
      { query: 'what did Mert say about his startup' },
      { extract: async () => ({ answer: 'Mert is building a freight logistics startup.', cited_ids: ['u-1'] }) as never },
    );

    expect(response.text).toBe('Mert is building a freight logistics startup.');
    expect(response.citations.map((citation) => citation.id)).toContain('u-1');
  });

  it('refuses rather than repeating a claim it cannot point at', async () => {
    const response = await answerQuestion(
      { query: 'what did Mert say about his startup' },
      { extract: async () => ({ answer: 'Mert raised four million dollars.', cited_ids: [] }) as never },
    );

    expect(response.text).toBe(NOTHING_IN_MEMORY);
    expect(response.citations).toEqual([]);
  });

  it('asks for a budget of its own rather than the extraction default', async () => {
    let asked: { maxTokens?: number; reasoningEffort?: string; salvageTruncated?: unknown } = {};
    await answerQuestion(
      { query: 'what did Mert say about his startup' },
      {
        extract: async (request) => {
          asked = request;
          return { answer: 'Mert is building a freight logistics startup.', cited_ids: ['u-1'] } as never;
        },
      },
    );

    expect(asked.maxTokens).toBeGreaterThan(0);
    expect(asked.reasoningEffort).toBe('low');
    expect(asked.salvageTruncated).toBeTypeOf('function');
  });

  it('keeps a salvaged answer whose last citation was cut in half', async () => {
    const response = await answerQuestion(
      { query: 'what did Mert say about his startup' },
      {
        extract: async () =>
          ({
            answer: 'Mert is building a freight logistics startup.',
            cited_ids: ['u-1', 'u-'],
          }) as never,
      },
    );

    expect(response.text).toBe('Mert is building a freight logistics startup.');
    expect(new Set(response.citations.map((citation) => citation.id))).toEqual(new Set(['u-1']));
  });

  it('says it ran out of room rather than returning a server error', async () => {
    const response = await answerQuestion(
      { query: 'what did Mert say about his startup' },
      {
        extract: async () => {
          throw new TokenCapError('{"answer":"Mert is buil');
        },
      },
    );

    expect(response.text).toBe(ANSWER_CUT_SHORT);
    expect(response.authorized).toBe(true);
    expect(response.citations).toEqual([]);
  });

  it('says the same when the cap left an answer with no sentence in it', async () => {
    const response = await answerQuestion(
      { query: 'what did Mert say about his startup' },
      { extract: async () => ({ cited_ids: [] }) as never },
    );

    expect(response.text).toBe(ANSWER_CUT_SHORT);
  });

  it('cites a turn once even when search and the assembled context both found it', async () => {
    const response = await answerQuestion(
      { query: 'what did Mert say about his startup', conversation_id: 'c1' },
      {
        extract: async () =>
          ({ answer: 'Mert is building a freight logistics startup.', cited_ids: ['u-1'] }) as never,
      },
    );

    expect(response.citations.map((citation) => citation.id)).toEqual(['u-1']);
  });

  it('does not claim an empty memory when the cap took the citations', async () => {
    const response = await answerQuestion(
      { query: 'what did Mert say about his startup' },
      {
        extract: async (request) => {
          request.salvageTruncated?.('{"answer":"Mert is building a freight logistics startup.","cited_ids":[');
          return { answer: 'Mert is building a freight logistics startup.', cited_ids: [] } as never;
        },
      },
    );

    expect(response.text).toBe(ANSWER_CUT_SHORT);
  });

  it('still lets a real failure reach the caller', async () => {
    await expect(
      answerQuestion(
        { query: 'what did Mert say about his startup' },
        {
          extract: async () => {
            throw new Error('Fireworks extraction failed: 401');
          },
        },
      ),
    ).rejects.toThrow(/401/);
  });

  it('assembles a whole-conversation view for a question with nothing to search on', async () => {
    let prompt = '';
    await answerQuestion(
      { query: 'what did we talk about?' },
      {
        extract: async (request) => {
          prompt = request.user;
          return { answer: 'Mert talked about his startup.', cited_ids: ['u-1'] } as never;
        },
      },
    );

    expect(prompt).toContain('Assembled context');
    expect(prompt).toContain('Mert:');
    expect(prompt).toContain('u-1');
  });
});

describe('checking the request before answering it', () => {
  it('accepts a question with only a query', () => {
    expect(askRequestProblem({ query: 'what did Mert say?' })).toBeNull();
  });

  it('names the field a caller sending the wrong one is missing', () => {
    expect(askRequestProblem({ question: 'what did Mert say?' })).toMatch(/query/);
  });

  it('rejects a body that is not an object at all', () => {
    for (const body of [undefined, null, 'query', ['query']]) {
      expect(askRequestProblem(body)).toMatch(/JSON object/);
    }
  });

  it('rejects a query that is present but empty', () => {
    expect(askRequestProblem({ query: '   ' })).toMatch(/empty/);
  });

  it('rejects an id sent as something other than a string', () => {
    expect(askRequestProblem({ query: 'who?', person_id: 7 })).toMatch(/person_id/);
  });

  it('leaves the optional ids optional', () => {
    expect(askRequestProblem({ query: 'who?', conversation_id: 'c1' })).toBeNull();
  });
});

describe('answering with nothing recorded at all', () => {
  it('says so without calling the model', async () => {
    const extract = vi.fn();
    const response = await answerQuestion({ query: 'what did anyone say about scuba diving in Belize' }, { extract });

    expect(response.text).toBe(NOTHING_IN_MEMORY);
    expect(extract).not.toHaveBeenCalled();
  });
});

describe('authorization', () => {
  const ask = { query: 'what did Tarun say?' };

  it('refuses a voice request from someone who is not the owner', async () => {
    const denied = await answerQuestion(
      { ...ask, requester_voiceprint_id: 'vp-stranger' },
      { verifyOwnerVoice: async () => false },
    );
    expect(denied.authorized).toBe(false);
    expect(denied.citations).toEqual([]);
  });

  it('refuses when a voiceprint is supplied but nothing can verify it', async () => {
    const result = await answerQuestion({ ...ask, requester_voiceprint_id: 'vp-1' });
    expect(result.authorized).toBe(false);
  });

  it('fails closed when the verifier throws', async () => {
    const result = await answerQuestion(
      { ...ask, requester_voiceprint_id: 'vp-1' },
      {
        verifyOwnerVoice: async () => {
          throw new Error('sidecar down');
        },
      },
    );
    expect(result.authorized).toBe(false);
  });
});

describe('inline ids', () => {
  const citable = new Set<Id>(['fact-abc', 'utt-9']);

  it('takes ids out of the prose without touching the citations', () => {
    const grounded = groundAnswer(
      'Boris studies operations research (fact-abc). Vova is from Ukraine (utt-9).',
      ['fact-abc', 'utt-9'],
      citable,
    );
    expect(grounded.text).toBe('Boris studies operations research. Vova is from Ukraine.');
    expect(grounded.cited).toEqual(new Set(['fact-abc', 'utt-9']));
  });

  it('leaves an answer that never mentioned one exactly as written', () => {
    const answer = 'Boris studies operations research.';
    expect(groundAnswer(answer, ['fact-abc'], citable).text).toBe(answer);
  });

  it('leaves no empty bracket behind when the model padded the id with zero-width spaces', () => {
    const grounded = groundAnswer(
      'Boris studies operations research [​fact-abc​]. Vova is from Ukraine [​utt-9​].',
      ['fact-abc', 'utt-9'],
      citable,
    );
    expect(grounded.text).toBe('Boris studies operations research. Vova is from Ukraine.');
  });

  it('does not strip text that merely looks like an id', () => {
    const answer = 'They discussed fact-checking and utt-most importance.';
    expect(groundAnswer(answer, ['fact-abc'], citable).text).toBe(answer);
  });
});
