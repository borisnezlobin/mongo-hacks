---
name: langchain-hackathon
description: Applies LangChain and LangGraph patterns for agent memory, checkpoints, and tool calling with MongoDB Atlas. Use when implementing persistent agent state, LangGraph workflows, or hackathon LangSmith credit integration.
---

# LangChain — agent memory with MongoDB

## Hackathon resources

- $50 LangChain/LangSmith credits — claim via hackathon instructions link
- **Adding Memory (JS)**: MongoDB docs — chat history in Atlas
- **LangGraph + MongoDB**: thread checkpoints, crash recovery
- **Building an Agent with Memory and Function Calling** — aligns with Amelia `/ask` tools

## Amelia fit

Amelia uses a **custom Hono bus + SSE**, not LangGraph end-to-end. Use LangChain patterns selectively:

| Pattern | Amelia equivalent |
|---|---|
| MongoDB chat history store | `utterances` + `facts` + `promises` collections |
| Vector retrieval | Lane B `searchMemory()` via Atlas Vector Search |
| Tool calling | Amelia tools: `searchMemory`, `resolveFactState`, `createReminder`, `addNote` |
| Checkpoints | Append-only facts with supersession; never delete voiceprints |

## If importing LangGraph (optional stretch)

```typescript
import { MongoDBSaver } from '@langchain/langgraph-checkpoint-mongodb';

const checkpointer = new MongoDBSaver({ client, dbName: 'amelia' });
// Use for multi-step /ask only — not for real-time utterance pipeline
```

Prefer `@langchain/mongodb` for vector store only if Lane B time allows — native driver + `$vectorSearch` is already scaffolded in `db/indexes.json`.

## Judging angle

LangChain counts for **Technologies Used** when MongoDB is the memory backing store and LangGraph/LCEL orchestrates tool loops — not when MongoDB is just a log dump.

## Do not

- Replace `shared/contracts.ts` types with LangChain abstractions in cross-lane surfaces
- Add LangGraph dependency without team announcement (lockfile owner: Lane B / contracts owner)
