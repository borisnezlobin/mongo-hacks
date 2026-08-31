/**
 * Put a real recording into the store the way the pipeline would.
 *
 * Runs the actual attribution and name-inference paths rather than hand-labelled
 * data, so what lands in storage is what the product would really produce —
 * including its mistakes. Seeding a corrected version would make every
 * downstream check meaningless.
 *
 *   AMELIA_STORAGE=local AMELIA_DATA_DIR=... npx tsx tools/seed-from-recording.mts <fixture-stem>
 */

import { readFile } from 'node:fs/promises';
import {
  CONFIRMED_SPEECH_MS,
  OWNER_ID,
  PROVISIONAL_SPEECH_MS,
  type Conversation,
  type Person,
  type Utterance,
} from '../shared/contracts';
import { readWav } from '../server/audio/wav';
import { suggestNames } from '../server/naming/index';
import { hasRealRecording, missingRecordingNotice, readRealRecording, realFixturePath } from '../fixtures/real-audio';
import { getStorage } from '../server/storage';

const stem = process.argv[2] ?? 'dorm-40min';

async function main(): Promise<void> {
  if (!hasRealRecording(stem)) throw new Error(missingRecordingNotice(stem));

  // One composition of the pipeline, shared with the freshness check the review
  // page runs and with the suites. Hand-rolling it here is what put a store on
  // screen that the page then correctly called stale.
  const run = readRealRecording(stem);
  console.log(`attribution: ${run.speakerCount} speakers over ${run.segments.length} lines`);

  const lines = run.segments
    .filter((segment) => segment.text.trim())
    .map((segment, index) => ({
      id: `${stem}-u${index}`,
      speaker: segment.speaker,
      text: segment.text,
      start_ms: segment.start_ms,
      end_ms: segment.end_ms,
    }));

  const suggested = suggestNames({ conversation_id: stem, turns: lines });
  const nameFor = new Map<string, string>();
  for (const suggestion of suggested.suggestions) {
    const voice = suggestion.session_speaker ?? suggestion.person_id;
    if (voice && !nameFor.has(voice)) nameFor.set(voice, suggestion.name);
  }
  console.log(`names overheard: ${[...nameFor.entries()].map(([v, n]) => `${n}(${v})`).join(', ') || 'none'}`);

  const storage = await getStorage();
  const now = new Date().toISOString();
  const people = storage.collection<Person>('people');
  const conversations = storage.collection<Conversation>('conversations');
  const utterances = storage.collection<Utterance>('utterances');

  /**
   * How sure we are WHO a voice is, which is a property of the voice and not of
   * any one turn — so it is uniform across everything that voice said, exactly
   * as the identity lane emits it.
   *
   * An earlier version of this script derived it from the pipeline's crosstalk
   * flag instead. Those measure different things: crosstalk is "two people are
   * talking over each other here", identity confidence is "we know which person
   * this is". Conflating them scattered `provisional` turns through every
   * speaker, and since extraction requires a speaker's whole window to be
   * settled before it will file anything, the result was zero facts from a
   * 48-minute conversation with no error anywhere to explain it.
   */
  const tierFor = new Map<string, 'pending' | 'provisional' | 'confirmed'>();
  for (const [voice, speechMs] of run.speechMsBySpeaker) {
    tierFor.set(
      voice,
      speechMs >= CONFIRMED_SPEECH_MS
        ? 'confirmed'
        : speechMs >= PROVISIONAL_SPEECH_MS
          ? 'provisional'
          : 'pending',
    );
  }

  // A voice with no overheard name is still a person — an unnamed one. That is
  // the normal state of most people the owner meets, and the app is built to
  // offer a tap on exactly these.
  const personIdFor = new Map<string, string>();
  const voices = [...run.speechMsBySpeaker.keys()];
  for (const [index, voice] of voices.entries()) {
    const name = nameFor.get(voice);
    const id = `${stem}-p${index}`;
    personIdFor.set(voice, id);
    await people.updateOne(
      { _id: id },
      {
        $set: {
          _id: id,
          owner_id: OWNER_ID,
          name: name ?? 'Unnamed voice',
          ...(name ? {} : { is_unnamed: true }),
          updated_at: now,
        },
        $setOnInsert: { created_at: now },
      },
      { upsert: true },
    );
  }

  const startedAt = new Date(Date.now() - run.totalSpeechMs).toISOString();
  await conversations.updateOne(
    { _id: stem },
    {
      $set: {
        _id: stem,
        owner_id: OWNER_ID,
        started_at: startedAt,
        ended_at: now,
        participant_ids: [...personIdFor.values()],
      },
    },
    { upsert: true },
  );

  let written = 0;
  for (const [index, segment] of run.segments.entries()) {
    if (!segment.text.trim()) continue;
    const id = `${stem}-u${index}`;
    await utterances.updateOne(
      { _id: id },
      {
        $set: {
          _id: id,
          owner_id: OWNER_ID,
          conversation_id: stem,
          person_id: personIdFor.get(segment.speaker),
          identity_confidence: tierFor.get(segment.speaker),
          text: segment.text.trim(),
          start_ms: segment.start_ms,
          end_ms: segment.end_ms,
          is_final: true,
          updated_at: now,
        },
        $setOnInsert: { created_at: now },
      },
      { upsert: true },
    );
    written += 1;
  }

  console.log(`seeded ${voices.length} people and ${written} attributed turns into "${stem}"`);
  await storage.close();
}

void main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
