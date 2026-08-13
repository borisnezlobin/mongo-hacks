/**
 * ElevenLabs TTS — Amelia's spoken reply.
 *
 * Flash v2.5 for latency: this runs while four people stand around waiting.
 * Audio is written to disk and served back via GET /amelia/audio/:file, which
 * is what AmeliaAudioEvent.audio_url points at.
 *
 * Uses fetch rather than the pre-installed `@elevenlabs/elevenlabs-js`: one
 * HTTP call, no version coupling, nothing added to the frozen dependency list.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const MODEL_ID = process.env.ELEVENLABS_MODEL ?? 'eleven_flash_v2_5';
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID ?? '21m00Tcm4TlvDq8ikWAM';

export const AUDIO_DIR = process.env.AMELIA_AUDIO_DIR ?? '/tmp/amelia-audio';
export const AUDIO_MIME = 'audio/mpeg';

let seq = 0;

export interface SpokenReply {
  audio_url: string;
  path: string;
  mime_type: string;
}

/**
 * Returns null rather than throwing when TTS is unavailable — a missing key on
 * stage should cost Amelia her voice, not her answer.
 */
export async function speak(text: string): Promise<SpokenReply | null> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey || !text.trim()) return null;

  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          text,
          model_id: MODEL_ID,
          voice_settings: { stability: 0.4, similarity_boost: 0.75 },
        }),
      },
    );
    if (!res.ok) {
      console.error(`[tts] ElevenLabs ${res.status}: ${await res.text()}`);
      return null;
    }

    await mkdir(AUDIO_DIR, { recursive: true });
    const name = `amelia_${Date.now()}_${++seq}.mp3`;
    const path = join(AUDIO_DIR, name);
    await writeFile(path, Buffer.from(await res.arrayBuffer()));

    return { audio_url: `/amelia/audio/${name}`, path, mime_type: AUDIO_MIME };
  } catch (error) {
    console.error('[tts] failed:', error);
    return null;
  }
}
