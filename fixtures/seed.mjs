import { MongoClient } from 'mongodb';
import transcript from './transcript.json' with { type: 'json' };

const uri = process.env.MONGODB_URI;
if (!uri) throw new Error('MONGODB_URI is required');
const client = new MongoClient(uri);

async function main() {
  await client.connect();
  const db = client.db();
  const now = new Date().toISOString();
  await db.collection('people').updateOne(
    { _id: 'p-amelia-owner' },
    { $set: { owner_id: 'owner', name: 'Yan', is_owner: true, updated_at: now }, $setOnInsert: { created_at: now } },
    { upsert: true },
  );
  // Deterministic 192-dimensional owner fixture. Replace with the venue enrollment
  // embedding for production attribution; keeping this seed makes the wake gate repeatable.
  const embedding = Array.from({ length: 192 }, (_, index) => Math.sin(index * 0.017) * 0.05);
  await db.collection('voiceprints').updateOne(
    { _id: 'vp-owner-seed' },
    { $set: { owner_id: 'owner', person_id: 'p-amelia-owner', embedding, duration_ms: 4700, created_at: now } },
    { upsert: true },
  );
  for (const utterance of transcript.utterances) {
    await db.collection('utterances').updateOne(
      { _id: utterance.utterance_id },
      { $set: { ...utterance, owner_id: 'owner', conversation_id: transcript.conversation_id, is_final: true, created_at: now, updated_at: now } },
      { upsert: true },
    );
  }
  console.log('Seeded Amelia demo data');
}

main().finally(() => client.close());
