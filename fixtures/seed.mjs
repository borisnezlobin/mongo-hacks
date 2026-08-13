import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
import transcript from './transcript.json' with { type: 'json' };

export const DEMO_PEOPLE = [
  { _id: 'p-amelia-owner', name: 'Yan', is_owner: true },
  { _id: 'p-maya', name: 'Maya' },
  { _id: 'p-jules', name: 'Jules' },
  { _id: 'p-priya', name: 'Priya' },
];

export function demoParticipantIds() {
  return [...new Set(transcript.utterances.map((utterance) => utterance.person_id))];
}

export function demoConversation(now) {
  return {
    _id: transcript.conversation_id,
    owner_id: 'owner',
    started_at: now,
    ended_at: now,
    title: 'Demo conversation',
    participant_ids: demoParticipantIds(),
  };
}

export function ownerVoiceprintEmbedding() {
  return Array.from({ length: 192 }, (_, index) => Math.sin(index * 0.017) * 0.05);
}

function isDirectRun(argv = process.argv, moduleUrl = import.meta.url) {
  const thisFile = fileURLToPath(moduleUrl);
  const thisDir = dirname(thisFile);
  return argv.slice(1).some((arg) => {
    try {
      return resolve(arg) === thisFile || resolve(thisDir, arg) === thisFile;
    } catch {
      return false;
    }
  });
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required');
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db();
    const now = new Date().toISOString();
    for (const person of DEMO_PEOPLE) {
      await db.collection('people').updateOne(
        { _id: person._id },
        { $set: { owner_id: 'owner', name: person.name, is_owner: person.is_owner ?? false, updated_at: now }, $setOnInsert: { created_at: now } },
        { upsert: true },
      );
    }
    await db.collection('conversations').updateOne(
      { _id: transcript.conversation_id },
      { $set: demoConversation(now) },
      { upsert: true },
    );
    // Deterministic 192-dimensional owner fixture. Replace with the venue enrollment
    // embedding for production attribution; keeping this seed makes the wake gate repeatable.
    await db.collection('voiceprints').updateOne(
      { _id: 'vp-owner-seed' },
      { $set: { owner_id: 'owner', person_id: 'p-amelia-owner', embedding: ownerVoiceprintEmbedding(), duration_ms: 4700, created_at: now } },
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
  } finally {
    await client.close();
  }
}

if (isDirectRun()) {
  await main();
}
