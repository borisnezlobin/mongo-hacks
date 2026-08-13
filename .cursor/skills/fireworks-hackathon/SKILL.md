---
name: fireworks-hackathon
description: Uses Fireworks AI for LLM inference in hackathon projects. Use when routing model calls to Fireworks, claiming MONGODB813 credits, or choosing open models for agent reasoning alongside MongoDB memory.
---

# Fireworks AI — hackathon credits

## Credits

- Code: `MONGODB813` ($50, deadline 10/1/2026)
- Docs: https://docs.fireworks.ai/
- Cookbook: https://github.com/fw-ai/cookbook

## When to use in Amelia

Fireworks is optional — Amelia defaults to Anthropic (`ANTHROPIC_API_KEY`) for `/ask` reasoning. Use Fireworks when:

- Anthropic rate limits hit at venue
- You want a fast open model for memory extraction (facts/promises) in Lane B slow pass
- Judging **Technologies Used** — show thoughtful multi-provider integration

## OpenAI-compatible API

```typescript
const response = await fetch('https://api.fireworks.ai/inference/v1/chat/completions', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${process.env.FIREWORKS_API_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: 'accounts/fireworks/models/llama-v3p1-70b-instruct',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 1024,
  }),
});
```

Set `FIREWORKS_API_KEY` in `server/.env` (add to `.env.example` when first used).

## Amelia patterns

- **Fast pass** (every utterance): keep on Claude Haiku or Fireworks small model for attribute extraction
- **Slow pass** (every 25 utterances): larger Fireworks model for promise normalization + supersession review
- Always persist extracted facts/promises to MongoDB — model choice must not change schema

## Do not

- Send raw voiceprint embeddings to Fireworks
- Use Fireworks as the only memory store — MongoDB is the source of truth
