---
name: anthropic-amelia
description: Uses Anthropic Claude for Amelia agent reasoning, tool calling, and memory extraction. Use when implementing POST /ask, wake/authorize gates, or structured fact/promise extraction in Lane B/D.
---

# Anthropic — Amelia reasoning

## Setup

- Env: `ANTHROPIC_API_KEY` in `server/.env`
- Package: `@anthropic-ai/sdk` (root workspace)
- Limit: `AMELIA_MAX_TOOL_CALLS = 5` (contracts.ts)

## Amelia `/ask` flow (Lane D)

1. **Wake** — detect "Amelia" in finalized utterance text
2. **Authorize** — compare requester voiceprint to owner threshold (`OWNER_AUTH_THRESHOLD = 0.60`)
3. **Reason** — Claude with tools bound to `MemoryApi` exports only
4. **Reply** — text → ElevenLabs TTS → `amelia_audio` SSE

```typescript
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

const message = await anthropic.messages.create({
  model: 'claude-sonnet-4-20250514',
  max_tokens: 1024,
  tools: [/* searchMemory, resolveFactState, createReminder, addNote schemas */],
  messages: [{ role: 'user', content: query }],
});
```

## Lane B extraction (fast/slow pass)

- **Fast pass** (`FAST_PASS_LOOKBACK_TURNS = 8`): Haiku-class model for attribute + claim extraction per utterance
- **Slow pass** (`SLOW_PASS_EVERY_N_UTTERANCES = 25`): Sonnet for supersession review + promise normalization

Persist all outputs to MongoDB before emitting SSE — memory must survive agent restart.

## Do not

- Import Lane B internals from Lane D — use `shared/contracts.ts` `MemoryApi` only
- Exceed tool call cap in demo (looks unstable on stage)
