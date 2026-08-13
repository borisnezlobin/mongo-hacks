---
name: openrouter-hackathon
description: Routes LLM requests through OpenRouter for hackathon projects. Use when configuring OpenRouter API credits, model fallback, or multi-model agent routing alongside MongoDB-backed memory.
---

# OpenRouter — model routing

## Credits

- $10 API credits via hackathon claim instructions
- Docs: https://openrouter.ai/docs
- Unified OpenAI-compatible API across many models

## Setup

```bash
# server/.env
OPENROUTER_API_KEY=sk-or-...
```

## Amelia usage

Fallback router when primary provider fails or for cost/latency experiments:

```typescript
const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': 'https://github.com/your-org/amelia',
    'X-Title': 'Amelia Persistent Context',
  },
  body: JSON.stringify({
    model: 'anthropic/claude-3.5-haiku',
    messages: [{ role: 'user', content: prompt }],
  }),
});
```

## Model suggestions for Amelia

| Task | Model hint |
|---|---|
| Fact extraction | `anthropic/claude-3.5-haiku` or `openai/gpt-4o-mini` |
| Amelia `/ask` reply | `anthropic/claude-sonnet-4` |
| Cheap bulk embedding captions | skip — use Voyage for embeddings |

## Judging

Counts toward **Technologies Used** when OpenRouter is a deliberate routing layer (fallback, A/B, cost control) — not a single opaque `fetch`.

## Do not

- Store OpenRouter keys in `EXPO_PUBLIC_*` vars
- Send PII-heavy utterances to models without team consent at demo
