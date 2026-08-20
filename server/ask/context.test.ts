/**
 * Assembly against real storage, including the real 48-minute recording.
 *
 * The questions under test are the ones a long conversation makes hard: what
 * did we talk about, who was there, what did one person say. None of them have
 * useful search terms in them, so they exercise coverage rather than ranking.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OWNER_ID, type Person, type Utterance } from '../../shared/contracts';
import { hasRealRecording, missingRecordingNotice, readRealLines } from '../../fixtures/real-audio';
import { closeStorage, createLocalDriver, useStorage, type LocalDriver } from '../storage';

const embeddings = vi.hoisted(() => ({ embedDocuments: vi.fn(), embedQuery: vi.fn() }));
vi.mock('../memory/embeddings', () => embeddings);

import { assembleContext, clearPassageVectorCache, renderContext } from './context';
import { tokenize } from './scoring';
import { collections } from '../memory/db';

let dataDir: string;
let driver: LocalDriver;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'amelia-context-'));
  driver = await createLocalDriver({ dataDir, fsync: false });
  useStorage(driver);
  clearPassageVectorCache();
  embeddings.embedQuery.mockRejectedValue(new Error('embeddings offline in tests'));
  embeddings.embedDocuments.mockRejectedValue(new Error('embeddings offline in tests'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeStorage();
  await rm(dataDir, { recursive: true, force: true });
});

async function addConversation(id: string, startedAt: string, participants: string[] = []): Promise<void> {
  await collections
    .conversations()
    .insertOne({ _id: id, owner_id: OWNER_ID, started_at: startedAt, participant_ids: participants });
}

async function addPerson(id: string, over: Partial<Person> = {}): Promise<void> {
  await collections
    .people()
    .insertOne({ _id: id, owner_id: OWNER_ID, name: '', created_at: 'now', updated_at: 'now', ...over });
}

function utterance(id: string, conversationId: string, personId: string, text: string, startSeconds: number): Utterance {
  return {
    _id: id,
    owner_id: OWNER_ID,
    conversation_id: conversationId,
    person_id: personId,
    text,
    start_ms: startSeconds * 1_000,
    end_ms: (startSeconds + 3) * 1_000,
    is_final: true,
    created_at: 'now',
    updated_at: 'now',
  };
}

const TOPICS = [
  'the dining hall closes at eight on weekends which nobody warned us about',
  'my sister goes to Cal Poly and drove up for the weekend to visit',
  'I am doing applied maths with a double major in industrial engineering',
  'the bus to campus is quicker than cycling once it starts raining properly',
  'I ping everyone I meet about every forty five days to keep in touch',
];

/** The words that belong to exactly one of the subjects above. */
function subjectKeywords(): Array<Set<string>> {
  return TOPICS.map(
    (topic, index) =>
      new Set(tokenize(topic).filter((term) => !TOPICS.some((other, position) => position !== index && other.includes(term)))),
  );
}

/** Five subjects, two speakers, spread evenly across an hour. */
async function seedSpreadConversation(): Promise<void> {
  await addConversation('c-long', '2026-08-01T20:00:00.000Z');
  await addPerson('p-a', { name: 'Mert' });
  await addPerson('p-b', { is_unnamed: true, name: 'Unknown speaker' });

  let position = 0;
  for (const [topicIndex, topic] of TOPICS.entries()) {
    for (let repeat = 0; repeat < 12; repeat += 1) {
      const speaker = repeat % 2 === 0 ? 'p-a' : 'p-b';
      await collections
        .utterances()
        .insertOne(utterance(`u-${topicIndex}-${repeat}`, 'c-long', speaker, topic, position * 20));
      position += 1;
    }
  }
}

describe('assembling context for a broad question', () => {
  beforeEach(seedSpreadConversation);

  it('falls back to the most recent conversation when nothing is scoped', async () => {
    const context = await assembleContext();
    expect(context.conversations.map((conversation) => conversation.id)).toEqual(['c-long']);
  });

  it('quotes from both ends of the conversation, not the top of one cluster', async () => {
    const context = await assembleContext({}, { granularity: 'overview' });
    const quoted = context.blocks.flatMap((block) => block.quotes.map((quote) => quote.utterance_id));
    const subjectOf = (id: string) => id.split('-')[1];

    expect(context.coverage.passages_quoted).toBeGreaterThan(1);
    expect(subjectOf(quoted[0])).toBe('0');
    expect(subjectOf(quoted[quoted.length - 1])).toBe(String(TOPICS.length - 1));
    expect(new Set(quoted.map(subjectOf)).size).toBeGreaterThanOrEqual(TOPICS.length - 1);
  });

  it('describes every subject in the timeline, including ones it did not quote', async () => {
    const context = await assembleContext({}, { granularity: 'overview' });
    const mentioned = new Set(context.timeline.flatMap((entry) => entry.topics));

    expect(context.timeline.length).toBeGreaterThan(1);
    for (const words of subjectKeywords()) {
      expect([...words].some((word) => mentioned.has(word))).toBe(true);
    }
  });

  it('labels every quoted line with who said it', async () => {
    const context = await assembleContext({}, { granularity: 'overview' });
    const quotes = context.blocks.flatMap((block) => block.quotes);

    expect(quotes.length).toBeGreaterThan(0);
    expect(quotes.every((quote) => quote.speaker.length > 0)).toBe(true);
    expect(new Set(quotes.map((quote) => quote.speaker))).toEqual(new Set(['Mert', 'Speaker 1']));
  });

  it('cites ids that exist', async () => {
    const context = await assembleContext({}, { granularity: 'overview' });
    const stored = await collections.utterances().find({ owner_id: OWNER_ID }).toArray();
    const real = new Set(stored.map((item) => item._id));

    expect(context.citable_utterance_ids.length).toBeGreaterThan(0);
    expect(context.citable_utterance_ids.every((id) => real.has(id))).toBe(true);
  });

  it('spends roughly the budget it was given', async () => {
    const small = await assembleContext({}, { granularity: 'overview', budget_words: 100 });
    const large = await assembleContext({}, { granularity: 'overview', budget_words: 600 });

    expect(small.coverage.quoted_words).toBeLessThan(200);
    expect(large.coverage.quoted_words).toBeGreaterThan(small.coverage.quoted_words);
  });

  it('degrades to a lexical focus when embeddings are down', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const context = await assembleContext({ about: 'Cal Poly' }, { granularity: 'detail' });
    const quoted = context.blocks.flatMap((block) => block.quotes.map((quote) => quote.text));

    expect(quoted.some((text) => text.includes('Cal Poly'))).toBe(true);
    warn.mockRestore();
  });

  it('says so plainly when the scope holds nothing', async () => {
    const context = await assembleContext({ conversation_id: 'c-nothing' });
    expect(context.blocks).toEqual([]);
    expect(context.note).toMatch(/nothing/i);
  });
});

describe('semantic focus', () => {
  beforeEach(seedSpreadConversation);

  /** Stands in for the embedding model: one axis meaning "about somebody's family". */
  const familyAxis = (text: string) => (/sister|family|relatives/i.test(text) ? [1, 0.1] : [0.1, 1]);

  it('finds a passage that shares no words with the question', async () => {
    embeddings.embedQuery.mockImplementation(async (text: string) => familyAxis(text));
    embeddings.embedDocuments.mockImplementation(async (texts: string[]) => texts.map(familyAxis));

    const context = await assembleContext(
      { about: 'does anyone here have relatives nearby' },
      { granularity: 'detail' },
    );
    const quoted = context.blocks.flatMap((block) => block.quotes.map((quote) => quote.text)).join(' ');

    expect(quoted).toContain('sister');
    expect(embeddings.embedDocuments).toHaveBeenCalled();
  });

  it('embeds each passage once and reuses it for the next question', async () => {
    embeddings.embedQuery.mockImplementation(async (text: string) => familyAxis(text));
    embeddings.embedDocuments.mockImplementation(async (texts: string[]) => texts.map(familyAxis));

    await assembleContext({ about: 'relatives nearby' }, { granularity: 'detail' });
    const firstBatch = embeddings.embedDocuments.mock.calls.at(-1)?.[0]?.length ?? 0;
    await assembleContext({ about: 'anything about family' }, { granularity: 'detail' });

    expect(firstBatch).toBeGreaterThan(0);
    expect(embeddings.embedDocuments).toHaveBeenCalledTimes(1);
  });
});

describe('assembling context for one person', () => {
  beforeEach(async () => {
    await addConversation('c-two', '2026-08-02T20:00:00.000Z');
    await addPerson('p-mert', { name: 'Mert' });
    await addPerson('p-josh', { name: 'Josh' });
    await collections.utterances().insertOne(utterance('u-1', 'c-two', 'p-mert', 'I am building a startup around freight logistics', 0));
    await collections.utterances().insertOne(utterance('u-2', 'c-two', 'p-josh', 'that sounds like a hard market to break into', 4));
    await collections.utterances().insertOne(utterance('u-3', 'c-two', 'p-mert', 'we have two pilot customers in Istanbul already', 8));
  });

  it('returns what that person said, not what was said near them', async () => {
    const context = await assembleContext({ person_id: 'p-mert' }, { granularity: 'verbatim' });
    const quotes = context.blocks.flatMap((block) => block.quotes);

    expect(quotes.map((quote) => quote.utterance_id).sort()).toEqual(['u-1', 'u-3']);
    expect(quotes.every((quote) => quote.speaker === 'Mert')).toBe(true);
  });
});

const RECORDING = 'dorm-40min';

describe('the real 48-minute conversation, through storage', () => {
  const available = hasRealRecording(RECORDING);
  const maybe = available ? it : it.skip;
  if (!available) it.skip(missingRecordingNotice(RECORDING), () => undefined);

  beforeEach(async () => {
    if (!available) return;
    const lines = readRealLines(RECORDING);
    await addConversation('c-dorm', '2026-08-16T21:00:00.000Z');

    for (const speaker of new Set(lines.map((line) => line.speaker))) {
      await addPerson(`p-${speaker}`, { is_unnamed: true, name: 'Unknown speaker' });
    }
    for (const [position, line] of lines.entries()) {
      await collections.utterances().insertOne({
        _id: `u-dorm-${position}`,
        owner_id: OWNER_ID,
        conversation_id: 'c-dorm',
        person_id: `p-${line.speaker}`,
        text: line.text,
        start_ms: line.start_ms,
        end_ms: line.end_ms,
        is_final: true,
        created_at: '2026-08-16T21:00:00.000Z',
        updated_at: '2026-08-16T21:00:00.000Z',
      });
    }
  });

  maybe('answers a question with no search terms in it with a bounded, spread sample', async () => {
    const context = await assembleContext({ about: 'what did we talk about' }, { granularity: 'overview' });
    const rendered = renderContext(context);

    expect(context.coverage.passages).toBeGreaterThan(20);
    expect(context.coverage.quoted_words).toBeLessThan(900);
    expect(rendered.length).toBeLessThan(20_000);

    const quotedAt = context.blocks.map((block) => Number(block.at.split(':')[0]));
    expect(Math.min(...quotedAt)).toBeLessThan(8);
    expect(Math.max(...quotedAt)).toBeGreaterThan(38);
  }, 60_000);

  maybe('keeps attribution attached through the reduction', async () => {
    const context = await assembleContext({}, { granularity: 'overview' });
    const quotes = context.blocks.flatMap((block) => block.quotes);

    expect(quotes.length).toBeGreaterThan(10);
    expect(quotes.every((quote) => /^Speaker \d+$/.test(quote.speaker))).toBe(true);
    expect(new Set(quotes.map((quote) => quote.speaker)).size).toBeGreaterThan(2);
  }, 60_000);

  maybe('quotes only turns that exist', async () => {
    const context = await assembleContext({}, { granularity: 'overview' });
    const stored = await collections.utterances().find({ owner_id: OWNER_ID }).toArray();
    const real = new Set(stored.map((item) => item._id));

    expect(context.citable_utterance_ids.length).toBeGreaterThan(0);
    expect(context.citable_utterance_ids.every((id) => real.has(id))).toBe(true);
  }, 60_000);
});
