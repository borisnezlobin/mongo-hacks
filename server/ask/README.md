# Lane B retrieval

`searchMemory(query, personId?)` is the only entry point Lane D and the app see, and
its signature is unchanged. Behind it are five stages, each of which degrades to the
stage before it rather than failing the request.

| Stage | File | What it does |
|---|---|---|
| 1. Plan | `query-plan.ts` | One LLM call turns the question into paraphrases, a hypothetical answer, and lexical keywords. Runs in parallel with the stage-2 leg for the original question, so most of its latency is hidden. |
| 2. Recall | `candidates.ts` | Every formulation runs a hybrid fact search: Atlas `$rankFusion` over `facts_vector` + `facts_text`, or the hand-rolled two-pipeline RRF on clusters without it. Promises and utterances come from a keyword scan. |
| 3. Fuse | `fusion.ts` | Weighted reciprocal-rank fusion across formulations. Rank-based, because a cosine, a BM25 score, and a `$rankFusion` meta score share no scale. |
| 4. Rerank | `rerank.ts` | One LLM call scores each candidate 0–3 against the question. Zeros are dropped; the judgement is blended 75/25 with recall order. |
| 5. Trim | `fusion.ts` | At most two live facts per (person, attribute) before the rest are pushed to the tail, then cut to the limit. |

Why the hypothetical answer matters: stored facts are declarative ("Sarah drinks oat
milk lattes") and questions are interrogative ("what does Sarah drink"). Embedding an
invented answer searches from the same side of the space the facts live on.

Only live facts are ever returned. Supersession is filtered inside each retrieval leg,
not after fusion, so a leg cannot spend its limit on stale claims.

## Switches

All optional; the defaults are what the demo runs.

| Variable | Default | Effect |
|---|---|---|
| `ASK_QUERY_PLANNING` | on | `0` skips stage 1 and searches the raw question. |
| `ASK_RERANK` | on | `0` skips stage 4 and returns fusion order. |
| `ASK_RRF_FALLBACK` | off | `1` forces the hand-rolled RRF instead of `$rankFusion`. |
| `ASK_MAX_VARIANTS` | 3 | Extra formulations per question. |
| `ASK_NUM_CANDIDATES` | 200 | `numCandidates` for `$vectorSearch`. |
| `ASK_LEG_LIMIT` | 25 | Rows per retrieval leg. |
| `ASK_RERANK_POOL` | 24 | Candidates shown to the reranker. |
| `ASK_ATTRIBUTE_CAP` | 2 | Facts per (person, attribute) before overflow. |
| `ASK_LIMIT` | 10 | Final result count. |

Setting both LLM stages off leaves the previous behaviour: one hybrid search over the
raw question. Tests inject stages directly through `RetrievalOptions`, so none of this
needs a cluster or an inference key.
