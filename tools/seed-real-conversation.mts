/**
 * Put the real dorm conversation into the store, so the app opens on something
 * true instead of an empty list.
 *
 * Seeds the three people with their actual ECAPA voiceprints — so the phone can
 * genuinely recognise them if they talk again — plus the conversation and every
 * turn attributed to whoever really said it.
 *
 * Run BEFORE starting the server: the local driver holds state in memory, so a
 * second process writing underneath a running server would not be seen.
 *
 *   AMELIA_STORAGE=local AMELIA_DATA_DIR=... npx tsx tools/seed-real-conversation.mts
 */

import { OWNER_ID, type Conversation, type Person, type Utterance, type Voiceprint } from '../shared/contracts';
import { hasRealFixture, missingFixtureNotice, readRealFixture } from '../fixtures/real-audio';
import { getStorage } from '../server/storage';
import { OWNER_PERSON_ID } from '../server/amelia/wake';

const DIARIZE = 'dorm-9pm.diarize.json';
const PRINTS = 'cross-session.json';

/** Ground truth for this recording, from the owner. */
const SPEAKERS: Record<string, { name: string; owner?: boolean }> = {
  A: { name: 'Josh' },
  C: { name: 'You', owner: true },
  G: { name: 'Tarun' },
};

interface Segment {
  speaker: string;
  start: number;
  end: number;
  text: string;
}
interface SessionFixture {
  session_mean: number[];
  speakers: Record<string, { embedding: number[]; duration_ms: number }>;
}

const CONVERSATION_ID = 'dorm-9pm-aug-17';
const STARTED_AT = '2026-08-17T21:00:00.000Z';

async function main(): Promise<void> {
  for (const fixture of [DIARIZE, PRINTS]) {
    if (!hasRealFixture(fixture)) throw new Error(missingFixtureNotice(fixture));
  }

  const segments = readRealFixture<{ segments: Segment[] }>(DIARIZE).segments;
  const prints = readRealFixture<{ enroll: SessionFixture; test: SessionFixture }>(PRINTS);
  const storage = await getStorage();
  const now = new Date().toISOString();

  const people = storage.collection<Person>('people');
  const voiceprints = storage.collection<Voiceprint>('voiceprints');
  const conversations = storage.collection<Conversation>('conversations');
  const utterances = storage.collection<Utterance>('utterances');

  const personIdFor = new Map<string, string>();
  for (const [label, who] of Object.entries(SPEAKERS)) {
    const id = who.owner ? OWNER_PERSON_ID : `p-${who.name.toLowerCase()}`;
    personIdFor.set(label, id);
    await people.updateOne(
      { _id: id },
      {
        $set: {
          _id: id,
          owner_id: OWNER_ID,
          name: who.name,
          ...(who.owner ? { is_owner: true } : {}),
          updated_at: now,
        },
        $setOnInsert: { created_at: now },
      },
      { upsert: true },
    );

    // Both halves of the recording, so each person carries more than one print
    // and the next room has more to match against.
    for (const [half, fixture] of Object.entries(prints)) {
      const pooled = fixture.speakers[who.owner ? 'Me' : who.name];
      if (!pooled) continue;
      const printId = `vp-${id}-${half}`;
      await voiceprints.updateOne(
        { _id: printId },
        {
          $set: {
            _id: printId,
            owner_id: OWNER_ID,
            person_id: id,
            embedding: pooled.embedding,
            session_mean: fixture.session_mean,
            duration_ms: pooled.duration_ms,
            source_conversation_id: CONVERSATION_ID,
            enrolled: true,
            created_at: now,
          },
        },
        { upsert: true },
      );
    }
  }

  const known = segments.filter((segment) => personIdFor.has(segment.speaker));
  await conversations.updateOne(
    { _id: CONVERSATION_ID },
    {
      $set: {
        _id: CONVERSATION_ID,
        owner_id: OWNER_ID,
        started_at: STARTED_AT,
        ended_at: new Date(Date.parse(STARTED_AT) + 179_300).toISOString(),
        title: 'In the room, before the stargazing event',
        participant_ids: [...new Set(known.map((s) => personIdFor.get(s.speaker)!))],
      },
    },
    { upsert: true },
  );

  let written = 0;
  for (const [index, segment] of known.entries()) {
    if (!segment.text.trim()) continue;
    const id = `${CONVERSATION_ID}-u${index}`;
    await utterances.updateOne(
      { _id: id },
      {
        $set: {
          _id: id,
          owner_id: OWNER_ID,
          conversation_id: CONVERSATION_ID,
          person_id: personIdFor.get(segment.speaker),
          voiceprint_id: `vp-${personIdFor.get(segment.speaker)}-enroll`,
          text: segment.text.trim(),
          start_ms: Math.round(segment.start * 1000),
          end_ms: Math.round(segment.end * 1000),
          is_final: true,
          updated_at: now,
        },
        $setOnInsert: { created_at: now },
      },
      { upsert: true },
    );
    written += 1;
  }

  console.log(`seeded ${personIdFor.size} people with voiceprints`);
  console.log(`seeded "${CONVERSATION_ID}" with ${written} attributed turns`);
  await storage.close();
}

void main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
