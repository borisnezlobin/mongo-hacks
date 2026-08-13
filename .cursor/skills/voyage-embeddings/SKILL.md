---
name: voyage-embeddings
description: Generates and queries text embeddings with Voyage AI for Amelia MongoDB vector search. Use when embedding facts, promises, or utterances, configuring voyage-3.5-lite, or working with the 1024-dim Atlas vector indexes.
---

# Voyage AI — Amelia embeddings

## Frozen constants (shared/contracts.ts)

- Model: `voyage-3.5-lite`
- Dimensions: `1024` (`VOYAGE_DIMS`)
- Env: `VOYAGE_API_KEY`
- Package: `voyageai` (root workspace)

## Index cap (do not change dims)

Atlas Sandbox allows **3 search indexes**. Amelia uses:

1. `facts_vector` — 1024-dim cosine on `facts.embedding`
2. `promises_vector` — 1024-dim cosine on `promises.embedding`
3. `utterances_text` — Atlas Search lexical on `utterances.text`

Re-applying indexes with wrong dimensions requires a redo — always use `VOYAGE_DIMS`.

## Embed pattern (Lane B)

```typescript
import { VoyageAIClient } from 'voyageai';

const voyage = new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY! });

const { data } = await voyage.embed({
  input: [text],
  model: 'voyage-3.5-lite',
  inputType: 'document', // use 'query' for searchMemory query side
});

const embedding = data[0].embedding; // length 1024
```

## Minimum duration gate

Only embed utterances where `(end_ms - start_ms) >= EMBED_MIN_MS` (3000 ms) to avoid junk vectors from backchannels.

## Hybrid search

Prefer `$rankFusion` when available; fallback: two-pipeline RRF (Lane B owns both). See `mongodb-search-and-ai` skill.

## Do not

- Switch to MongoDB `$embed` automated embeddings mid-hackathon (index/schema lock-in)
- Embed before `claim_normalized` / `text_normalized` are stable
