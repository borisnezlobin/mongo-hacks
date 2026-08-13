---
name: elevenlabs-amelia
description: Integrates ElevenLabs text-to-speech for Amelia agent voice replies in the Persistent Context Sprint hackathon. Use when implementing TTS, streaming audio responses, voice personality, or the ElevenLabs prize track (agentic depth, low latency, emotional inflection).
---

# ElevenLabs — Amelia voice replies

## Hackathon context

- Creator tier: redeem via hackathon Discord (#coupon-codes → Start Redemption)
- Env: `ELEVENLABS_API_KEY` in `server/.env`
- Package: `@elevenlabs/elevenlabs-js` (root workspace)
- Lane D owns `/server/amelia/` — Amelia speaks via TTS after authorized `/ask`

## Prize criteria (optimize for these)

1. **Agentic depth** — TTS is the output of a tool-using agent, not a standalone speak button
2. **Interaction design** — low latency; stream where possible; natural pacing for dialogue
3. **Technical integration** — creative API use (streaming, `previous_text` continuity, voice settings)
4. **Novelty** — voice-summoned memory agent with voiceprint auth

## Amelia integration pattern

```typescript
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';

const client = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY! });

// Low-latency mobile playback: pcm_16000 or mp3_44100_128
const audio = await client.textToSpeech.convert(voiceId, {
  text: replyText,
  modelId: 'eleven_turbo_v2_5', // prefer turbo for latency in demo
  outputFormat: 'mp3_44100_128',
  voiceSettings: { stability: 0.45, similarityBoost: 0.8, style: 0.15, speed: 1.05 },
});
```

Emit `amelia_audio` SSE event (see `shared/contracts.ts`) with `audio_url` or base64 for the app.

## Streaming (preferred for demo feel)

Use `client.textToSpeech.stream()` when reply text is ready; pipe chunks to client or buffer to object storage. Pair with `amelia_step` events (`step: 'reply'`) so UI shows reasoning before audio.

## Voice selection

- Pick one voice ID at venue and hardcode or env `ELEVENLABS_VOICE_ID`
- Warm, conversational — not announcer
- Test with: "Maya moves to Oakland on September fifteenth, and Jules promised venue photos tonight."

## Do not

- Block the agent loop on full audio synthesis before emitting `amelia_step: reply`
- Use zero-retention mode unless required (breaks request stitching)
- Put API keys in client bundle — server-side only

## References

- API: https://elevenlabs.io/docs/api-reference/text-to-speech/convert
- Full docs index: https://elevenlabs.io/docs/llms.txt
