# Lane B retrieval

`searchMemory(query, personId?)` is the only entry point Lane D and the app see, and
its signature is unchanged. Behind it are five stages, each of which degrades to the
stage before it rather than failing the request.

| Stage | File | What it does |
|---|---|---|
| 1. Plan | `query-plan.ts` | One LLM call turns the question into paraphrases and a hypothetical answer. **Off by default** — see below. |
| 2. Recall | `candidates.ts` | Every formulation runs a hybrid fact search: Atlas `$rankFusion` over `facts_vector` + `facts_text`, or the hand-rolled two-pipeline RRF on clusters without it. Promises and utterances come from a keyword scan. |
| 3. Fuse | `fusion.ts` | Weighted reciprocal-rank fusion across formulations. Rank-based, because a cosine, a BM25 score, and a `$rankFusion` meta score share no scale. |
| 4. Rerank | `rerank.ts` | One LLM call scores each candidate 0–3 against the question. Zeros are dropped; the judgement is blended 75/25 with recall order. |
| 5. Trim | `fusion.ts` | At most two live facts per (person, attribute) before the rest are pushed to the tail, then cut to the limit. |

Why the hypothetical answer matters: stored facts are declarative ("Sarah drinks oat
milk lattes") and questions are interrogative ("what does Sarah drink"). Embedding an
invented answer searches from the same side of the space the facts live on.

Only live facts are ever returned. Supersession is filtered inside each retrieval leg,
not after fusion, so a leg cannot spend its limit on stale claims.

## Latency

The Fireworks account serialises concurrent requests — two at once measured 881 ms
against 553 ms for one, four at once 1,414 ms. So the budget is the **number of
inference requests**, not the critical path, and the pipeline is built around that:

- Every formulation is embedded in **one** request, after planning rather than
  overlapping it.
- The whole pool is judged in **one** request. Splitting it across concurrent calls
  was measurably slower.
- The keyword scan needs no embedding and no plan, so it rides alongside the Atlas
  legs, which are a different service and do run concurrently.

Measured against the fixture memory, `when is Maya moving and where to`:

| Configuration | Requests | End to end |
|---|---|---|
| Recall only (`ASK_RERANK=0`) | 1 embed | ~0.3 s |
| **Default** (recall + rerank) | 1 embed, 1 chat | **1.1–2.3 s** |
| Planning on as well | 2 chat, 1 embed | 3.3 s |

Stage 1 is off by default because it is a whole request on the critical path, roughly
900 ms, and on the fixture memory it surfaced no fact the question had not already
found. It is a hedge against vocabulary mismatch, which needs a larger memory to pay
for itself. Turn it on with `ASK_QUERY_PLANNING=1`.

## Switches

| Variable | Default | Effect |
|---|---|---|
| `ASK_QUERY_PLANNING` | off | `1` enables stage 1. |
| `ASK_RERANK` | on | `0` skips stage 4 and returns fusion order. |
| `ASK_RRF_FALLBACK` | off | `1` forces the hand-rolled RRF instead of `$rankFusion`. |
| `ASK_PLAN_DEADLINE_MS` | 1200 | How long stage 1 may hold up stage 2 before it is abandoned. |
| `ASK_MAX_VARIANTS` | 3 | Extra formulations per question. |
| `ASK_NUM_CANDIDATES` | 200 | `numCandidates` for `$vectorSearch`. |
| `ASK_LEG_LIMIT` | 25 | Rows per retrieval leg. |
| `ASK_RERANK_POOL` | 16 | Candidates judged. The main recall/latency dial. |
| `ASK_SCAN_LIMIT` | 5 | Promise and utterance rows the keyword scan may add, each. |
| `ASK_ATTRIBUTE_CAP` | 2 | Facts per (person, attribute) before overflow. |
| `ASK_LIMIT` | 10 | Final result count. |

Setting both LLM stages off leaves the previous behaviour: one hybrid search over the
raw question. Tests inject stages directly through `RetrievalOptions`, so none of this
needs a cluster or an inference key.

## Probing it

```
npx tsx server/ask/probe.mts "when is Maya moving and where to"
```

Runs one question through every stage, prints what each did, then reruns it with the
LLM stages off and diffs the two rankings. Read-only.
