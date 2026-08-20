/**
 * Load a whisper + pyannote transcript into the store.
 *
 * The text comes from whisper over the whole file and the speakers from
 * pyannote, joined at word level. Names are not supplied: they are inferred
 * from what people call each other, the same way a live recording would get
 * them, so this seeds the state the product would really produce.
 *
 *   AMELIA_STORAGE=local AMELIA_DATA_DIR=... npx tsx tools/seed-transcript.mts <stem>
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OWNER_ID, type Conversation, type Person, type Utterance } from '../shared/contracts';
import { suggestNames } from '../server/naming/index';
import { getStorage } from '../server/storage';

interface Line {
  speaker: string | null;
  text: string;
  start: number;
  end: number;
}

const here = dirname(fileURLToPath(import.meta.url));
const stem = process.argv[2] ?? 'dorm-40min';
const lines: Line[] = JSON.parse(
  readFileSync(join(here, `../eval/real/${stem}.transcript.json`), 'utf8'),
).lines;

async function main(): Promise<void> {
  const spoken = lines.filter((line) => line.text.trim());
  const turns = spoken.map((line, index) => ({
    id: `${stem}-u${index}`,
    speaker: line.speaker ?? `unattributed-${index}`,
    text: line.text,
    start_ms: Math.round(line.start * 1000),
    end_ms: Math.round(line.end * 1000),
  }));

  const suggested = suggestNames({ conversation_id: stem, turns });
  const nameFor = new Map<string, string>();
  for (const suggestion of suggested.suggestions) {
    const voice = suggestion.session_speaker ?? suggestion.person_id;
    if (voice && !nameFor.has(voice)) nameFor.set(voice, suggestion.name);
  }
  console.log(
    `names overheard: ${[...nameFor.entries()].map(([v, n]) => `${n}=${v}`).join(', ') || 'none'}`,
  );

  const voices = [...new Set(spoken.map((line) => line.speaker).filter(Boolean))] as string[];
  const speechMs = new Map<string, number>();
  for (const line of spoken) {
    if (!line.speaker) continue;
    speechMs.set(line.speaker, (speechMs.get(line.speaker) ?? 0) + (line.end - line.start) * 1000);
  }

  const storage = await getStorage();
  const now = new Date().toISOString();
  const people = storage.collection<Person>('people');
  const conversations = storage.collection<Conversation>('conversations');
  const utterances = storage.collection<Utterance>('utterances');

  const personIdFor = new Map<string, string>();
  for (const [index, voice] of voices.entries()) {
    const id = `${stem}-p${index}`;
    const name = nameFor.get(voice);
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

  await conversations.updateOne(
    { _id: stem },
    {
      $set: {
        _id: stem,
        owner_id: OWNER_ID,
        started_at: new Date(Date.now() - 2_902_000).toISOString(),
        ended_at: now,
        title: 'In the dorm, meeting everyone',
        participant_ids: [...personIdFor.values()],
      },
    },
    { upsert: true },
  );

  let written = 0;
  for (const [index, line] of spoken.entries()) {
    const id = `${stem}-u${index}`;
    const personId = line.speaker ? personIdFor.get(line.speaker) : undefined;
    await utterances.updateOne(
      { _id: id },
      {
        $set: {
          _id: id,
          owner_id: OWNER_ID,
          conversation_id: stem,
          ...(personId ? { person_id: personId } : {}),
          // A voice with enough speech to be worth a name is settled; the rest
          // stay provisional so extraction will not file facts against them.
          identity_confidence:
            personId && (speechMs.get(line.speaker as string) ?? 0) >= 20_000
              ? 'confirmed'
              : 'provisional',
          text: line.text.trim(),
          start_ms: Math.round(line.start * 1000),
          end_ms: Math.round(line.end * 1000),
          is_final: true,
          updated_at: now,
        },
        $setOnInsert: { created_at: now },
      },
      { upsert: true },
    );
    written += 1;
  }

  console.log(`seeded ${voices.length} voices and ${written} turns into "${stem}"`);
  await storage.close();
}

void main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
