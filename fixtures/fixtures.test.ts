import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { DEMO_PEOPLE, demoConversation, demoParticipantIds } from './seed.mjs';
import transcript from './transcript.json';

describe('demo fixtures', () => {
  it('cover the required golden-path moments with four speakers', () => {
    const text = transcript.utterances.map((utterance) => utterance.text).join(' ');
    expect(new Set(transcript.utterances.map((utterance) => utterance.speaker)).size).toBe(4);
    expect(text).toMatch(/move date changed/i);
    expect(text).toMatch(/I promise/i);
    expect(text).toMatch(/Amelia, what should I remember/i);
    expect(text).toMatch(/Maya loves Ethiopian food/i);
  });

  it('seeds every person and conversation referenced by the transcript', () => {
    const personIds = demoParticipantIds();
    expect(personIds).toEqual(['p-amelia-owner', 'p-maya', 'p-jules', 'p-priya']);
    expect(DEMO_PEOPLE.map((person) => person._id)).toEqual(personIds);
    expect(demoConversation('2026-08-13T00:00:00.000Z')).toEqual({
      _id: 'demo-conversation',
      owner_id: 'owner',
      started_at: '2026-08-13T00:00:00.000Z',
      ended_at: '2026-08-13T00:00:00.000Z',
      title: 'Demo conversation',
      participant_ids: personIds,
    });
  });

  it('ships 16 kHz mono 16-bit PCM audio', async () => {
    const wav = await readFile(new URL('./conversation.wav', import.meta.url));
    expect(wav.subarray(0, 4).toString()).toBe('RIFF');
    expect(wav.subarray(8, 12).toString()).toBe('WAVE');
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt16LE(34)).toBe(16);
  });
});
