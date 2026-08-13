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
  // ECAPA-TDNN embedding of the two p-amelia-owner spans in conversation.wav.
  // Regenerate when the fixture audio changes; production enrollment adds the
  // real owner's voiceprint to the same person instead of using this demo clip.
  const embedding = [
    0.0969810039, -0.1308286339, -0.046662569, 0.0425486974, -0.1475171298,
    -0.0876311511, -0.1397371739, -0.0257828962, -0.0395585038, 0.0297856815,
    0.0447074398, 0.1074963436, -0.0978333801, 0.0242732763, -0.0656667948,
    0.0408784635, 0.0732148215, -0.1106926724, 0.061998859, 0.0528276376,
    -0.1015182659, -0.09354987, 0.0367990695, 0.0556581654, 0.0118521219,
    0.0209302027, 0.0249536149, 0.1103501767, -0.0214366224, -0.0139782093,
    -0.0641545057, -0.0152385999, 0.0863665491, -0.1013447866, -0.1538427621,
    0.1189509332, 0.1453534961, -0.0105666285, 0.0154916774, 0.098780185,
    -0.0312755331, 0.0832236335, 0.0333508812, 0.0321319699, -0.0711479709,
    -0.0349516943, -0.0567415915, -0.0273097083, 0.0283697154, 0.0279267617,
    -0.1241231859, -0.0184880812, 0.1840011328, 0.014051524, 0.0048410054,
    0.0431086048, -0.0481098518, -0.0725189149, -0.00901864, 0.0993334725,
    0.091351144, -0.0716668963, -0.1209055111, 0.0709230974, 0.098896794,
    0.0686991736, 0.0154995583, -0.0808596984, 0.1411150545, -0.0249464996,
    0.0261750892, 0.054430414, -0.0085371435, -0.0565723851, 0.1149403378,
    -0.136336565, 0.0202407949, -0.0115111591, 0.0811481252, -0.0515785776,
    -0.0338594429, 0.0849934071, 0.0552599132, 0.0070640375, -0.0073590903,
    0.0216712672, -0.0053948965, -0.006958215, 0.0444548652, 0.0384848639,
    -0.0068635168, 0.0014425825, 0.0431664623, -0.0515760332, -0.1039534807,
    0.0287066344, 0.0010955737, -0.0251654554, -0.0727245435, -0.0641529933,
    0.049833253, 0.0240853541, -0.0224370882, 0.0139390146, 0.1584623754,
    0.0773016214, 0.0164068136, 0.0534035675, 0.0017831052, -0.084663853,
    0.0295827258, -0.0926753655, -0.0576965511, 0.049857799, -0.0704421997,
    -0.0007284569, 0.0818520561, -0.0139404759, 0.0419933088, -0.0442727841,
    -0.0533127189, -0.0604185015, -0.0787237138, 0.0221398678, -0.0470734015,
    -0.1432679594, 0.0180050787, -0.0806209296, 0.1216108426, -0.0573440753,
    0.0144019937, 0.1615127176, 0.0072325529, 0.1076088846, -0.0872907564,
    -0.0837419033, 0.0078940699, -0.0276171975, -0.1671095192, -0.0751859322,
    0.0360784456, 0.0437055379, -0.0505561158, -0.010353731, 0.0405711904,
    0.0988457426, -0.0606388263, 0.1073276848, 0.0452830382, 0.0523262285,
    0.010565659, -0.125010401, -0.0444378071, 0.0532939099, -0.0082407454,
    -0.0552747734, -0.0306363553, 0.0150917526, 0.1230253056, 0.1254789233,
    0.1057325006, -0.0054856068, -0.0377568975, -0.0202741418, 0.0874283016,
    -0.0207805149, 0.0203761943, -0.0978521556, 0.0180500038, 0.1284736395,
    0.0434187837, -0.0086885616, 0.0819749907, 0.0051670857, 0.0669161081,
    -0.1584161669, -0.0304718819, -0.0751587898, -0.0375747345, 0.0583803542,
    -0.0625885725, -0.074076809, 0.0861738846, 0.1204375625, -0.0270299744,
    -0.0840205699, 0.0662071183, -0.118198663, -0.0442956686, -0.0558753908,
    -0.0145605057, -0.0359217115,
  ];
  const norm = Math.sqrt(embedding.reduce((sum, component) => sum + component ** 2, 0));
  return embedding.map((component) => component / norm);
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
    // Deterministic ECAPA owner fixture. Venue enrollment adds the real owner's
    // embedding to this person; the fixture keeps replay attribution repeatable.
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
