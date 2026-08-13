import { readFile } from 'node:fs/promises';

const baseUrl = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';
const fixture = JSON.parse(await readFile(new URL('./transcript.json', import.meta.url), 'utf8'));

for (const utterance of fixture.utterances) {
  const response = await fetch(`${baseUrl}/debug/utterance`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...utterance, conversation_id: fixture.conversation_id, is_final: true }),
  });
  if (!response.ok) throw new Error(`Replay failed (${response.status}): ${await response.text()}`);
  console.log(`${utterance.speaker}: ${utterance.text}`);
}
