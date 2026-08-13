# Lane D — Amelia

Wake detection, the agent loop, spoken replies, and email drafts.

Owns `/server/amelia`. Consumes Lane 0's bus and Lane B's `MemoryApi` through
`ServerDependencies`; never reads or writes Lane B's collections directly.

## Read this if you are not Lane D

Three changes here affect other lanes.

### 1. `@anthropic-ai/sdk` bumped `^0.61.0` → `^0.116.0`

**This changes the lockfile — pull before you install.** Version 0.61 predates
Claude Opus 5, `output_config`, and adaptive thinking, so Lane D cannot run on
it. No other lane's code depends on the old version.

### 2. `resolveFactState` cannot reach the supersession chain

`MemoryApi.resolveFactState` returns `Promise<Fact | null>` — the current fact
only. `Fact.superseded_by` points **forward** (old → new), so the current fact
has it unset and there is no back-pointer to what it replaced.

Lane D's step stream is supposed to read the real chain and say
`move in date updated Aug 15 → Aug 20`. It cannot, so that step currently
degrades to `move in date: Aug 20` — true, but it stops being the moment that
sells supersession, and it is the video's 20–32s beat.

Smallest fix that leaves Lane B's internals alone:

```ts
resolveFactState(personId: Id, attribute: string): Promise<{
  current: Fact | null;
  superseded: Fact[];   // oldest → newest, excluding current
}>
```

Marked `TODO(contracts)` in `tools.ts`. Lane C is unaffected — `FactEvent`
already carries `superseded_fact_id`.

### 3. `POST /amelia/summon` is not in `ApiContract`

The plan requires a press-and-hold manual summon as the stage net for a failed
voiceprint match, and `ApiContract` has no route for it. Lane D added
`POST /amelia/summon`.

`AskRequest`/`AskResponse` carry `requester_voiceprint_id`, `request_id`,
`authorized`, and `audio_url` — which is Amelia-shaped — but the plan assigns
`POST /ask` to Lane B. **Someone should decide out loud whether `/ask` is Lane
D's entry point.** If it is, `/amelia/summon` folds into it; that is a small
change now and a merge conflict later.

## Routes

| Route | Purpose |
| --- | --- |
| `POST /amelia/summon` | Press-and-hold manual summon. Skips the voiceprint gate — holding the phone is the auth. |
| `GET /amelia/drafts` | All email drafts, newest first. |
| `GET /amelia/drafts/:id` | One draft. |
| `POST /amelia/drafts/:id/send` | Owner-initiated send via Resend. Never called by a tool. |
| `GET /amelia/audio/:file` | Serves the mp3 that `AmeliaAudioEvent.audio_url` points at. |

The voice path is not a route: Lane D subscribes to the bus and reacts to
finalized utterances.

## Flow

```
utterance (bus, is_final)
  └─ detectWake: "hey amelia" + person_id === OWNER_ID + confidence ≥ OWNER_AUTH_THRESHOLD
       └─ runAmelia: tool-use loop, capped at AMELIA_MAX_TOOL_CALLS
            ├─ amelia_step per turn  → Lane C renders inline
            └─ final text → ElevenLabs → amelia_audio → phone plays
```

Both gates are required for a voice summon, and the gate **fails closed**: if
Lane A supplies no confidence, it is not a summon. That is exactly why the
press-and-hold route exists.

`ownerConfidenceFor` is an optional third argument to `registerAmeliaRoutes`.
Lane A wires it; until then every voice summon is correctly refused and the
manual route is the only way in.

## Behaviour worth knowing

- **One run at a time.** A new summon aborts the one in flight. Abort is checked
  before every model call, before and after every tool call, and again after TTS
  — not just inside `messages.create`. A superseded run must stop writing to the
  bus, stop running tools with side effects (`create_reminder`, `add_note`,
  `draft_email`), and never speak: otherwise the phone plays the stale answer
  aloud before the current one. Superseded manual summons get HTTP 409.
- **`max_tokens` is a failure, not a short answer.** It caps thinking + text
  together, so a truncated turn can carry a thinking block and no text at all.
  That surfaces as an `error` step and HTTP 503, never as an empty "reply" —
  otherwise Amelia goes silent while the UI reads "Answering".
- **Step dispatch from the bus is deferred a microtask.** `respond()` emits its
  first step synchronously, and the subscriber runs inside `bus.emit`'s dispatch
  loop; without the defer, SSE clients receive the step before the utterance
  that triggered it.
- **Tool cap.** At `AMELIA_MAX_TOOL_CALLS` the loop keeps `tools` in the request
  but sets `tool_choice: {type: 'none'}`, forcing a final answer. Dropping the
  tool definitions would invalidate the `tool_use` blocks already in history.
  A partial answer beats stalling.
- **TTS is best-effort.** No key or a failed call means `audio_url` is omitted;
  `AmeliaAudioEvent` still carries the text so the answer survives.
- **Email is draft-only.** `sendDraft` is deliberately not a tool. Recipient
  addresses come from memory, never from the model.

## Model provider

The loop is provider-neutral. `provider.ts` defines a normalized surface and
each backend translates to its own wire format:

| `AMELIA_PROVIDER` | Model | API |
| --- | --- | --- |
| `anthropic` | `claude-opus-5` | Messages API — `tool_use` / `tool_result` blocks |
| `fireworks` | `FIREWORKS_MODEL` (default `kimi-k3`) | OpenAI-compatible — `tool_calls` / `role:"tool"` |

Unset auto-selects: Anthropic when `ANTHROPIC_API_KEY` is present, otherwise
Fireworks. **These are different model families, not one model behind two
URLs** — Fireworks serves open weights, and it has no thinking/effort surface,
so `AMELIA_EFFORT` applies to Anthropic only. Fireworks *does* accept
`temperature`, which the loop pins to 0.

Currently running on Fireworks because the team's shared `ANTHROPIC_API_KEY` is
blank. Flipping back is one env var — no code change.

**Verified working end to end on `kimi-k3`:** all 8 canonical checks pass,
including the conditional branch on a superseded fact.

## Model parameters — do not "fix" these

- **No `temperature`.** Sampling parameters are removed on Opus 5 and return a
  400. Determinism comes from a tight system prompt plus a low effort level.
- **Thinking stays on.** With thinking disabled, Opus 5 occasionally writes a
  tool call into visible text instead of emitting a `tool_use` block — the call
  silently never runs, with no error. On stage that is a dead Amelia.
- **`max_tokens` caps thinking + text together**, so it needs real headroom.

Tune latency with `AMELIA_EFFORT` (`low` | `medium` | `high`, default `medium`),
not by disabling thinking.

## Environment

Added to `.env.example`: `RESEND_FROM`, `AMELIA_EFFORT`, `ELEVENLABS_MODEL`,
`ELEVENLABS_VOICE_ID`, `AMELIA_AUDIO_DIR`. Only `ANTHROPIC_API_KEY` is required;
without `ELEVENLABS_API_KEY` Amelia answers silently, and without
`RESEND_API_KEY` + `RESEND_FROM` drafts are created but cannot be sent.

## Tests

`bun run test` — `wake.test.ts` covers the gate, including the regression where
a bare punctuation token (`--`) made the command slice land mid-sentence.

The canonical-command test (does Amelia branch correctly on move-in date vs
today?) needs `ANTHROPIC_API_KEY` and is not yet wired into the suite.
