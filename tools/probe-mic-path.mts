/**
 * Drive the real capture path end to end, without a phone.
 *
 * Speaks exactly the wire protocol `app/audio` speaks: a WebSocket to /stream,
 * a JSON handshake, then float32 PCM in 1,600-sample frames paced at realtime.
 * Meanwhile it reads /events over SSE, the way the app does. So everything
 * between the microphone and the screen is genuinely exercised — the buffer,
 * the transcription provider, the clusterer, the ECAPA sidecar, identity, the
 * bus, and SSE — against real recorded speech instead of a synthetic fixture.
 *
 * Needs the server on PORT and the sidecar on SIDECAR_URL.
 *
 *   npx tsx tools/probe-mic-path.mts [path/to.wav]
 */

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { AUDIO_FRAME_SAMPLES, type AmeliaEvent } from '../shared/contracts';
import { readWav } from '../server/audio/wav';

const here = dirname(fileURLToPath(import.meta.url));
const base = process.env.PROBE_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`;
const wavPath = resolve(process.argv[2] ?? join(here, '../fixtures/real/dorm-9pm.wav'));

/** Pace faster than realtime so a 3-minute recording does not take 3 minutes. */
const SPEED = Number(process.env.PROBE_SPEED ?? 4);

interface Seen {
  utterances: Map<string, { text: string; person_id?: string; final: boolean }>;
  identities: AmeliaEvent[];
  pending: AmeliaEvent[];
  suggestions: AmeliaEvent[];
  order: string[];
}

async function main(): Promise<void> {
  const wav = readWav(await readFile(wavPath));
  const conversationId = `probe-${Date.now()}`;
  console.log(`audio  ${wavPath}`);
  console.log(`       ${(wav.samples.length / wav.sampleRate).toFixed(1)}s at ${wav.sampleRate} Hz, ${SPEED}x pace`);
  console.log(`server ${base}`);

  const health = await fetch(`${base}/health`).then((r) => r.json() as Promise<Record<string, unknown>>);
  console.log(`health ${JSON.stringify(health.storage)}`);

  const seen: Seen = {
    utterances: new Map(),
    identities: [],
    pending: [],
    suggestions: [],
    order: [],
  };

  const events = new AbortController();
  const sse = fetch(`${base}/events`, { signal: events.signal }).then(async (response) => {
    const reader = response.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const line = frame.split('\n').find((part) => part.startsWith('data: '));
        if (!line) continue;
        record(seen, JSON.parse(line.slice(6)) as AmeliaEvent);
      }
    }
  });
  void sse.catch(() => {});

  const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/stream`);
  await new Promise<void>((ready, fail) => {
    socket.once('open', () => ready());
    socket.once('error', fail);
  });
  socket.send(JSON.stringify({ conversation_id: conversationId }));

  const frameMs = (AUDIO_FRAME_SAMPLES / wav.sampleRate) * 1000;
  const started = Date.now();
  for (let offset = 0; offset < wav.samples.length; offset += AUDIO_FRAME_SAMPLES) {
    const frame = wav.samples.subarray(offset, offset + AUDIO_FRAME_SAMPLES);
    socket.send(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength));
    await new Promise((r) => setTimeout(r, frameMs / SPEED));
  }
  socket.close();
  console.log(`\npushed ${(wav.samples.length / wav.sampleRate).toFixed(1)}s of audio in ${((Date.now() - started) / 1000).toFixed(1)}s`);

  // The final diarization pass runs after the socket closes.
  await new Promise((r) => setTimeout(r, Number(process.env.PROBE_SETTLE_MS ?? 45_000)));
  events.abort();

  report(seen);
}

function record(seen: Seen, event: AmeliaEvent): void {
  switch (event.type) {
    case 'utterance': {
      if (!seen.utterances.has(event.utterance_id)) seen.order.push(event.utterance_id);
      seen.utterances.set(event.utterance_id, {
        text: event.text,
        person_id: event.person_id,
        final: event.is_final,
      });
      return;
    }
    case 'identity':
      seen.identities.push(event);
      return;
    case 'speaker_pending':
      seen.pending.push(event);
      return;
    case 'name_suggestion':
      seen.suggestions.push(event);
      return;
    default:
  }
}

function report(seen: Seen): void {
  const finals = [...seen.utterances.values()].filter((u) => u.final);
  const attributed = finals.filter((u) => u.person_id);
  console.log('\n================ result ================');
  console.log(`utterances      ${seen.utterances.size} (${finals.length} final)`);
  console.log(`attributed      ${attributed.length}/${finals.length}`);
  console.log(`speaker_pending ${seen.pending.length}`);
  console.log(`identities      ${seen.identities.length}`);
  const people = new Set(
    seen.identities.map((event) => (event as { person_id: string }).person_id),
  );
  console.log(`distinct people ${people.size}   (the recording has 3)`);

  if (seen.suggestions.length > 0) {
    console.log('\nnames overheard:');
    for (const suggestion of seen.suggestions) {
      const s = suggestion as { name: string; confidence: number; evidence: string };
      console.log(`  ${s.name} (${s.confidence.toFixed(2)}) from "${s.evidence}"`);
    }
  }

  console.log('\ntranscript:');
  for (const id of seen.order) {
    const utterance = seen.utterances.get(id);
    if (!utterance?.final || !utterance.text.trim()) continue;
    const who = utterance.person_id ? utterance.person_id.slice(0, 8) : '········';
    console.log(`  ${who}  ${utterance.text}`);
  }
}

void main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
