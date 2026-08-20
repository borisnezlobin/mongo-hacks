import { describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import type { Utterance } from '../../shared/contracts';
import {
  hasRealRecording,
  missingRecordingNotice,
  readRealLines,
  realFixturePath,
} from '../../fixtures/real-audio';

/**
 * The only test that spends money.
 *
 * Everything else in this directory mocks the provider, which proves the
 * plumbing and proves nothing about whether the extractor understands real
 * speech. This one replays an actual recording through the real prompt and
 * reports what came out, so precision can be hand-checked against the
 * transcript. It is off unless `AMELIA_LIVE_EXTRACTION=1` and the (gitignored)
 * recording is present, and it writes its output to a file rather than to the
 * report, because the transcript is personal data.
 */

const LIVE = process.env.AMELIA_LIVE_EXTRACTION === '1';
const RECORDING = process.env.AMELIA_LIVE_RECORDING ?? 'dorm-40min';
/**
 * Inside `fixtures/real/`, which is gitignored, because the facts extracted
 * from a real conversation are the conversation. The default used to be
 * `/tmp/amelia-live-extraction.json` — world-readable, and outside every rule
 * this repository has about where personal data may live.
 */
const OUTPUT = process.env.AMELIA_LIVE_OUTPUT ?? realFixturePath(`${RECORDING}.live-extraction.json`);

const recorded = vi.hoisted(() => ({ facts: [] as unknown[], promises: [] as unknown[] }));

vi.mock('./store', () => ({
  getPerson: async (id: string) => ({ _id: id, name: personName(id), owner_id: 'owner' }),
  findFactBySourceClaim: async () => null,
  resolveFactState: async () => null,
  recordFact: async (_bus: unknown, fact: unknown) => { recorded.facts.push(fact); },
  recordPromise: async (_bus: unknown, promise: unknown) => { recorded.promises.push(promise); },
}));
vi.mock('./db', () => ({
  collections: { utterances: () => ({ findOne: async () => null, find: () => ({ sort: () => ({ toArray: async () => [] }) }) }) },
}));

/**
 * Diarization labels are chunk-scoped and not yet resolved to people. For a
 * quality measurement each label stands in for one person, named after the
 * label so that nothing about who these people actually are leaks into the
 * prompt — which also means the third-party gate, which requires a subject's
 * real name to be spoken aloud, rejects essentially every third-party claim
 * here. Read the recall number with that in mind.
 */
function personName(personId: string): string {
  return `Speaker ${personId.replace(/^p-/, '')}`;
}

import { runWindowPass } from './passes';
import { WINDOW_CHAR_BUDGET, WINDOW_MAX_WAIT_MS, ConversationWindow } from './window';

describe('live extraction over a real recording', () => {
  it.skipIf(!LIVE || !hasRealRecording(RECORDING))('extracts a whole conversation in a handful of calls', async () => {
    const utterances: Utterance[] = readRealLines(RECORDING).map((line, index) => ({
      _id: `u-${index}`,
      owner_id: 'owner',
      conversation_id: 'c-real',
      person_id: `p-${line.speaker}`,
      // The harness measures extraction, not attribution: it hands every turn a
      // settled identity so that the identity gate never fires. Real recall in
      // production is lower by however often the identity lane is unsure.
      identity_confidence: 'confirmed',
      text: line.text,
      start_ms: line.start_ms,
      end_ms: line.end_ms,
      is_final: true,
      created_at: '2026-08-17T00:00:00Z',
      updated_at: '2026-08-17T00:00:00Z',
    }));

    const window = new ConversationWindow();
    const batches: Utterance[][] = [];
    for (const item of utterances) {
      window.add(item, item.start_ms);
      if (!window.isReady(item.end_ms)) continue;
      batches.push(window.take());
    }
    const tail = window.peek();
    if (tail.length > 0) batches.push(tail);

    const startedAt = Date.now();
    let calls = 0;
    const failures: string[] = [];
    for (const batch of batches) {
      try {
        if (await runWindowPass({ emit: () => undefined } as never, batch)) calls += 1;
      } catch (error) {
        failures.push(String(error));
      }
    }
    const elapsedMs = Date.now() - startedAt;

    writeFileSync(OUTPUT, JSON.stringify({
      recording: RECORDING,
      utterances: utterances.length,
      windows: batches.length,
      calls,
      failures,
      elapsed_ms: elapsedMs,
      window_char_budget: WINDOW_CHAR_BUDGET,
      window_max_wait_ms: WINDOW_MAX_WAIT_MS,
      facts: recorded.facts,
      promises: recorded.promises,
    }, null, 2));

    expect(calls).toBeLessThan(utterances.length / 10);
  }, 30 * 60_000);

  it.skipIf(hasRealRecording(RECORDING))('is skipped without the recording', () => {
    expect(missingRecordingNotice(RECORDING)).toContain('deliberately not committed');
  });
});
