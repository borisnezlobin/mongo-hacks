---
name: mentra-glasses
description: Integrates MentraOS Cloud SDK for smart-glasses audio I/O in Amelia stretch Lane E. Use after T+150 golden path when wiring glasses microphone uplink and ElevenLabs TTS to glasses speakers.
---

# MentraOS — glasses stretch (Lane E only)

## Start gate

**Do not start until T+150** — golden path on phone must work first.

## Package

- `@mentra/sdk` (pre-installed root workspace)
- Lane E owns `/server/glasses/` only

## Server-side audio pattern

```typescript
import { MentraClient, StreamType } from '@mentra/sdk';

// Subscribe to raw 16 kHz PCM from glasses mic
client.subscribe(StreamType.AUDIO_CHUNK, (chunk) => {
  // Forward into same pipeline as phone WS — reuse Lane A framing
});

// Speak Amelia reply through glasses speakers (ElevenLabs → Mentra TTS path)
await session.audio.speak(replyText);
```

## Webhook

Reserved route: `POST /glasses/webhook` (signature in contracts.ts `ApiContract`).

## Integration rule

Glasses are an **alternate uplink/downlink** — same bus events, same MongoDB memory. Never fork identity or memory logic into `/server/glasses/` internals.

## Do not

- Create `/server/glasses/` before T+150
- Edit frozen `server/index.ts` — export `registerGlassesRoutes` was not in T+15 scaffold; Lane 0 must add register hook via contracts owner if needed, or mount from existing pattern
