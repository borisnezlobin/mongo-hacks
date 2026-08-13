# Amelia — one-shot parallel build plan

## Context

Four-person team, MongoDB Persistent Context Sprint, Pier 48 SF, today (2026-08-13). Hacking 1:30–5:00 PM = **210 minutes**, not the 240 the build spec assumed. The build is Amelia: a phone app that diarizes live conversation, attributes utterances to people by voiceprint in Atlas, builds append-only per-person memory with attribute-keyed supersession, and hosts a voice-summoned, voiceprint-authorized agent. Judged Round 1 on a 60-second video + public repo (Creativity 35 / Demo 30 / Impact 20). Build must live in the MongoDB Atlas Hackathon Sandbox; repo must be public.

Decisions locked with user:
- **Glasses**: stretch lane only after golden path completes (MentraOS Cloud SDK is server-side: `subscribe(StreamType.AUDIO_CHUNK)` → raw 16 kHz PCM; `session.audio.speak()` is ElevenLabs TTS through glasses speakers)
- **Amelia speaks** replies via ElevenLabs TTS → targets the separate ElevenLabs prize
- **Executors**: 4 Claude agents, one per teammate laptop, each given a self-contained lane prompt from this plan

Spec contradictions resolved in this plan (were open items):
- Schedule compressed to 210 min: gates at T+15 / T+50 / T+100 / T+150 / T-60(=4:00 PM)
- Embedding duration floor: **3.0 s** (Amelia spec wins over older 4 s)
- Merge semantics: **bounded `updateMany`** re-pointing `person_id` on `utterances`, `facts`, `promises` inside the merge endpoint (read-time resolution via voiceprint_id would force every query through an extra `$lookup` and Agent 3's UI can't cheaply do it against SSE payloads). Never delete voiceprints.
- The video is a first-class deliverable owned by Lane D after T+100.

## Repo layout & anti-merge-conflict rules

New public repo `amelia` (NOT the siyi clone). Directory ownership is absolute — a lane never writes outside its tree:

```
/shared/contracts.ts        ← Lane 0 writes ONCE at T+15; changes announced aloud, owner: Lane B
/fixtures/                  ← Lane 0 (conversation.wav, transcript.json, seed.mjs)
/server/index.ts            ← Lane 0 scaffold; wires routers, never edited after T+15
/server/audio/              ← Lane A (human-driven)
/server/identity/           ← Lane A
/sidecar/                   ← Lane A (Python ECAPA)
/server/memory/             ← Lane B
/server/ask/                ← Lane B
/db/                        ← Lane B (index JSON + apply script)
/server/amelia/             ← Lane D
/server/glasses/            ← Lane E (stretch; only exists after T+150)
/app/audio/                 ← Lane A
/app/                       ← Lane C (everything else)
/video/                     ← Lane D (shot list, script)
```

Also frozen at T+15 (Lane 0 scaffolds, nobody edits after): `/server/index.ts`, `/server/lib/bus.ts` (typed event emitter + SSE hub), `package.json` + lockfiles (all dependencies pre-installed; later adds go through the contracts owner only), `app.json`, tsconfig/metro config.

Git: one branch per lane (`lane-a` … `lane-e`), merge to main only at gates, nobody rebases. Cross-lane needs go through `/shared/contracts.ts` + announcement. Server composition: `index.ts` imports `registerAudioRoutes(app, deps)`, `registerMemoryRoutes(app, deps)`, `registerAmeliaRoutes(app, deps)` etc. — each lane exports a register function from its own tree, so `index.ts` never needs editing after scaffold. Lanes communicate in-process via the bus and via the frozen call surfaces in contracts (Lane D → Lane B's exported functions; Lane C → Lane A's `useAudioUplink` hook), never by reaching into another lane's internals.

## Lane 0 — pre-start (TWO people; morning + ~40 min before 1:30)

Everything here has lead time that cannot be absorbed after the gun. **The dev-client rebuild in item 1 is the single longest-lead item in the entire plan — start it first.**

**Morning (before arriving):**
1. **Rebuild the dev client with audio capture.** The existing siyi dev client has NO audio-capture native module (verified: no `expo-audio`/`expo-av` in its package.json), and both capture options are native modules. Add `expo-audio` (fallback `@agus-eal/expo-audio-studio`) + `expo-notifications` + mic/notification permissions in `app.json`, then `npx expo run:ios --device` (or EAS dev build) and install on the demo phone. Without this, live mic, enrollment, and the T+100 gate are all impossible.
2. Record `/fixtures/conversation.wav` — the real four-person conversation, in noise, scripted so it contains: a self-introduction, a fact stated in someone else's sentence ("me too"), a supersession pair (move date changes), a clear promise, and the canonical Amelia command. Hand-write `/fixtures/transcript.json` (expected utterances with speaker labels) and `/fixtures/seed.mjs` — which must include a **precomputed owner voiceprint vector** (run the ECAPA sidecar once at home) so Lane D's wake-gate is testable without Lane A.
3. Verify the Resend sending domain (DNS propagation takes hours; fallback: Resend's onboarding sender). Redeem ElevenLabs Creator tier via Discord.

**At the venue (~40 min, person 1 = scaffold, person 2 = Atlas):**
4. Create public repo `amelia`. Scaffold: **bun workspaces** `/mobile` + `/server`, **Hono** server, metro `watchFolders` + tsconfig paths so `/shared/contracts.ts` imports from both sides. **Pre-install the complete dependency list for both packages now** (A: `ws`; B: `@anthropic-ai/sdk`, `voyageai`, `mongodb`; C: `react-native-sse`, `phosphor-react-native`, `@expo-google-fonts/manrope`, `@expo-google-fonts/newsreader`, `expo-image-picker`, `expo-notifications`; D: `elevenlabs`, `resend`; E: `@mentra/sdk`) — after this, any dependency add is announced and committed only by the contracts owner. `app.json` finalized here with all plugins/permissions; frozen after T+15.
5. Scaffold `/server/lib/bus.ts` — typed in-process event emitter + SSE hub (event types from contracts.ts) — and `/server/index.ts` wiring the per-lane register functions plus `POST /debug/utterance` (injects a finalized utterance onto the bus as if Lane A produced it). Both files frozen at T+15; they are the plumbing every lane consumes but no lane owns.
6. Write `/shared/contracts.ts` (full content below) and push. Owner: Lane B's human; any change announced out loud before push.
7. Atlas Hackathon Sandbox cluster live; apply all three indexes via `/db/apply-indexes.mjs`. Embedding model pinned in contracts (`voyage-3.5-lite`, 1024 dims) **before** indexes are applied — the 3-index cap means no redo. Verify the cap (two vector + one Atlas Search = at ceiling) and `$rankFusion` availability (fallback: two-pipeline RRF, Lane B carries both).
8. `/server/.env` from committed `.env.example`: `MONGODB_URI`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `PYANNOTE_API_KEY`, `ELEVENLABS_API_KEY`, `VOYAGE_API_KEY`, `RESEND_API_KEY`; `EXPO_PUBLIC_API_URL` (ngrok static URL) for the app. Real values pasted in group chat at T+15 — four laptops need them.
9. Enrollment recordings: calendar task at 1:35 PM, at the venue, on the demo phone; owner gets the longest, cleanest sample. Ask organizers: the missing 15% of rubric weight; whether precomputed seed embeddings are legal pre-work.

## `/shared/contracts.ts` — the anti-conflict artifact

Collection types exactly as the amendments doc fixes them (people, voiceprints, conversations, utterances, facts with `attribute` + `primary_source_utterance_id`, promises with `text_normalized`, reminders). Unique indexes: `facts (owner_id, primary_source_utterance_id, claim_normalized)`, `promises (owner_id, source_utterance_id, text_normalized)`.

**SSE (`GET /events`): full per-event payload types, not just tags.** Union `utterance | identity | fact | promise | amelia_step | amelia_audio`, each with a complete TS interface (e.g. `UtteranceEvent {type:'utterance', utterance_id, conversation_id, person_id, voiceprint_id, text, start_ms, end_ms, is_final}`). Revision semantics stated in the file: **an event re-emitted with the same `utterance_id` replaces the previous one** — that is how re-labels and revisions reach the UI, and Lane C's mock must emit the same shapes (mock imports the types).

**WS `/stream` framing:** binary frames = raw float32 PCM, 16 kHz mono, 100 ms (1600 samples/6400 bytes), first frame is a JSON text frame `{conversation_id}`.

**Cross-lane call surfaces frozen here:** (a) Lane B exports `searchMemory(query, personId?)`, `getPerson(id)`, `resolveFactState(personId, attribute)`, `createReminder(promiseId, fireAt)`, `addNote(personId, text)` — Lane D imports **only** these, never Lane B internals, and never writes Lane B collections directly. (b) Lane A exports from `/app/audio` the hook `useAudioUplink(conversationId): {state: 'idle'|'connecting'|'streaming'|'error', start(), stop()}` — Lane C's recording button consumes exactly this. (c) The bus event names/types (server-internal) mirror the SSE union.

REST signatures from spec §6 plus `POST /debug/utterance` (Lane 0 scaffold) and `POST /glasses/webhook` reserved for Lane E. Constants: `OWNER_ID`, `EMBED_MIN_MS = 3000`, `ATTRIBUTION_THRESHOLD = 0.75` (tune at venue), `OWNER_AUTH_THRESHOLD = 0.60`, `TONIGHT_DEFAULT_HOUR = 21`, `FAST_PASS_LOOKBACK_TURNS = 8`, `SLOW_PASS_EVERY_N_UTTERANCES = 25`, `AMELIA_MAX_TOOL_CALLS = 5`, `SSE_DEBOUNCE_MS = 200`, `VOYAGE_MODEL = 'voyage-3.5-lite'`, `VOYAGE_DIMS = 1024`. Merge contract: `POST /people/merge` keeps oldest `_id`, re-points `voiceprints`, then bounded `updateMany` on `utterances`/`facts`/`promises`, emits one `identity` event per affected conversation.

## Gates (210-minute clock; cut scope, never the gate)

| Wall clock | Gate |
|---|---|
| 1:45 (T+15) | Contracts + scaffold + fixtures pushed; env values shared; lanes start |
| 2:20 (T+50) | **Fixture-injection path end to end:** `/debug/utterance` replay of `transcript.json` → Mongo + SSE → utterances visible in app with speaker separation. (Real WAV replay through pyannote/Realtime is NOT required at this gate — 35 min cannot integrate the full audio spine.) |
| 3:10 (T+100) | Real WAV replay through the full audio spine, then identity live on real mics; unknown speakers appear; naming attaches history. Lane D human pivots to video+pitch |
| 4:00 (T+150) | Golden path complete once in sequence; Lane E (glasses) may start; everyone else integration-only |
| 4:00–4:45 | Full dry run in a noisy corner; whatever breaks is the only work left |
| 4:45 | Video final cut done (recorded against the 3:10–4:00 build) |

## Lane specs

Each spec below is written to be pasted verbatim as the opening prompt of a Claude Code session on that teammate's laptop (repo cloned, lane branch checked out). Every lane: read `/shared/contracts.ts` first; never write outside your directories; commit every ~15 min; no dark mode; no all-caps; Phosphor icons only; no emoji in UI.

### Lane A — audio + identity spine (human-driven, strongest teammate)

**Owns:** `/server/audio`, `/server/identity`, `/sidecar`, `/app/audio`. **Branch:** `lane-a`.

Build order: (1) `StreamBuffer` per conversation — `sample_cursor` monotonic counter is the only clock, all timestamps ms-from-stream-start; segments from pyannote `/v1/live`, words from OpenAI Realtime transcription (request word-level timestamps), word→segment by **midpoint containment**, utterances = consecutive words sharing a session speaker, revisions happen here only. Emit finalized utterances onto the Lane-0 bus (`/server/lib/bus.ts`) — extraction, Amelia and SSE all consume from there. (2) Replay path: pipe `/fixtures/conversation.wav` through the identical code path behind the `REPLAY` flag — target the T+100 gate (the T+50 gate runs on `/debug/utterance` transcript injection, which Lane 0 already scaffolded; you owe nothing for it). (3) Phone capture in `/app/audio`: `expo-audio` real-time PCM hook — **already installed in the morning dev-client rebuild** (verify exact hook name against the pinned SDK; fallback `@agus-eal/expo-audio-studio` is also in the build). Export exactly the `useAudioUplink(conversationId)` hook shape from contracts — Lane C's recording button consumes it. Frames already float32 −1..1 (no int16 round-trip), resample to 16 kHz mono on device, 100 ms chunks paced realtime over one uplink-only WebSocket (framing per contracts: JSON hello frame with `conversation_id`, then 6400-byte binary frames). (4) Python sidecar: ECAPA-TDNN (speechbrain), HTTP endpoint PCM→192-dim vector. (5) Identity: accumulate ≥`EMBED_MIN_MS` (3000) per session label, embed the concatenation of segments, `$vectorSearch` on `voiceprints` (cosine, top 3, filter `owner_id`), ≥`ATTRIBUTION_THRESHOLD` → match, below → create unnamed person + voiceprint, emit `identity` SSE. Two thresholds: strict attribution, loose `OWNER_AUTH_THRESHOLD` for Amelia's wake gate. Never match turns under the floor — hold as pending/Unknown. (6) `POST /enroll` — 10 s flow creating person + voiceprint.

**Skills:** `mongodb-connection` (Atlas driver/URI patterns), `mongodb-search-and-ai` ($vectorSearch syntax), `typescript-best-practices`. Agents are unreliable at streaming audio and buffer handling — drive this lane manually, use the agent for scaffolding and the sidecar.

**Done when:** replay WAV produces correctly-attributed utterances in Atlas; live mic on device does the same; enrollment works at the venue.

### Lane B — memory + retrieval

**Owns:** `/server/memory`, `/server/ask`, `/db`. **Branch:** `lane-b`. Never touches audio; develops entirely against `/fixtures/transcript.json`.

Build order: (1) `/db`: collection setup + three index JSONs (voiceprints vector 192/cosine/filter owner_id; facts vector Voyage-dims/filter owner_id+person_id; Atlas Search on `facts.claim` + `utterances.text`) + `apply-indexes.mjs` + unique indexes for event-identity idempotency — `facts (owner_id, primary_source_utterance_id, claim_normalized)`, `promises (owner_id, source_utterance_id, text_normalized)`; swallow duplicate-key errors. (2) Fast pass: every finalized turn, 8-turn lookback, promises/reminders only, window passed as **labelled turns** (facts live in other people's sentences); addressee = whoever raised the topic, ambiguous → skip; hedge threshold strict (first person + future tense + specific object); relative dates resolved at extraction with today's date in prompt, store ISO in `due_at` + phrase in `due_phrase`, "tonight" = 21:00 constant. (3) Slow pass: every 25 utterances — facts with `attribute` from short open vocabulary, then supersession as a defined step: lookup `(owner_id, person_id, attribute, superseded_by: null)` → none = insert; else model adjudicates replace / refine (carry `first_stated_at`) / coexist; vector similarity over that person's facts only as fallback. Naming guards: `set_name` binds to the speaker's voiceprint only, first-person introductions only, third-party "this is Michael" → suggestion event, already-named voice match = confirmation. (4) `POST /ask`: `$rankFusion` hybrid (Atlas Search pipeline + $vectorSearch pipeline over facts), with hand-rolled two-pipeline RRF behind a flag as fallback; answers cite utterance ids + dates; always resolve `superseded_by: null`. (5) `POST /people/merge`: keep oldest, re-point voiceprints, bounded `updateMany` on utterances/facts/promises, emit identity events. (6) Voyage embeddings on facts at insert — model and dims are pinned in contracts (`voyage-3.5-lite`, 1024) and the index is already applied; do not change them. (Check MongoDB Automated Embeddings on the sandbox tier only as an opportunistic simplification.) (7) Export the frozen call surface from contracts — `searchMemory`, `getPerson`, `resolveFactState`, `createReminder`, `addNote` — as named exports from `/server/memory/index.ts`; Lane D imports only these. Consume finalized utterances from the Lane-0 bus, never from Lane A's code directly.

**Skills:** `mongodb-schema-design`, `mongodb-search-and-ai` ($rankFusion, $vectorSearch, Atlas Search), `mongodb-query-optimizer`, `claude-api` (extraction LLM calls with tools — use tool-use loop, temperature 0).

**Done when:** replay transcript JSON → seeded extraction produces correct facts (with one supersession chain), promises both directions, and `/ask` answers "where did Jerry go" with citations.

### Lane C — app (all three tabs + conversation view)

**Owns:** `/app` except `/app/audio`. **Branch:** `lane-c`. Develops against `/fixtures/seed.mjs` data + a mock SSE stream (build the mock first, file in `/app/lib/mock-sse.ts`, **importing the event payload types from `/shared/contracts.ts`** so mock and real stream cannot drift; honor the "same `utterance_id` replaces" revision rule). The recording button calls Lane A's `useAudioUplink` hook exactly as typed in contracts — code against the type, not Lane A's branch. The notification test uses a seeded promise whose `fire_at` is ~2 minutes out (seed.mjs provides one).

Theme: light only; white/cream/light-grey; body face **Manrope**, display **Newsreader** (`@expo-google-fonts/*`, `useFonts` gating splash) — mirror siyi's `theme.ts` + `AppText` variant pattern (`apps/mobile/src/constants/theme.ts`, `src/components/app-text.tsx` in the siyi repo — reference for *pattern*, re-implement fresh, do not copy files). Buttons 8px radius or circular. Liquid glass only on floating elements (recording bar, Amelia pill). SSE client: `react-native-sse` (pure JS, no native module).

Screens: **Home** (ask field pinned top, recording control with unmistakable on-state, dismissible "N unnamed speakers" card → naming flow, recent conversations). **People** (alphabetical letter groups — siyi pattern `people-filters.ts:110-136` sectioning + sticky search bar via `stickyHeaderIndices`; search across names and fact text; profile: avatar, name, current facts with dates, promises both directions, conversation history; avatar via `expo-image-picker` `allowsEditing:true, aspect:[1,1]` native crop — siyi `person-form.tsx:155-191` is the reference interaction). **Loops** (open promises both directions, source sentence shown, tap to close). **Conversation view** (Slack-shaped bubbles; renameable title; tap avatar → person; bubbles must tolerate speaker re-labels after render — animate, don't flicker; deterministic identicon avatar derived from voiceprint id for unknowns, same avatar persists through naming; inline one-tap "this is…" on unknown speakers' bubbles; Amelia renders as one live-updating inline message consuming `amelia_step` events debounced `SSE_DEBOUNCE_MS`). Local notifications: `expo-notifications` `scheduleNotificationAsync` when a `promise`/`reminder` event carries `fire_at` (siyi has push-only, no local scheduling — write fresh, config pattern in siyi `native-push.ts:20-46`). Naming transition and Amelia's live status are the two delight moments — spend polish there.

**Skills:** `typescript-best-practices`, `unslop` (all UI copy), plus the visual rules above as hard constraints.

**Done when:** all screens render against seeded data; mock SSE drives live transcript with re-labels; naming flow works end to end; a scheduled local notification fires.

### Lane D — Amelia agent, TTS, then the pitch + video

**Owns:** `/server/amelia`, `/video`. **Branch:** `lane-d`. Develops against seeded Mongo — `seed.mjs` includes a precomputed owner voiceprint vector, and `POST /debug/utterance` injects finalized turns, so the wake gate is fully testable with zero Lane A code.

Build order: (1) Wake detection: "hey amelia" (case/punctuation-insensitive) in a finalized turn consumed from the Lane-0 bus; speaker must match owner at `OWNER_AUTH_THRESHOLD`; command = wake phrase → end of that speaker's turn (diarization turn-end, never mid-turn intent detection). (2) Agent loop: LLM tool-use loop capped at `AMELIA_MAX_TOOL_CALLS` (5); tools `search_memory`, `get_person`, `resolve_fact_state`, `draft_email`, `create_reminder`, `add_note` — the first five bind to Lane B's frozen exports from contracts (import from `/server/memory/index.ts` only; never write Lane B's collections directly). Partial answer at cap beats stalling. (3) Step streaming: one `amelia_step` `{label, detail}` per loop turn, Mongo-flavoured labels ("Searching Jerry's memory… / Found 3 relevant facts / Resolving newer information… / Move date updated Aug 15 → Aug 20 / Drafting…") — the supersession line reads the actual `supersedes` chain. (4) Spoken reply: ElevenLabs TTS (Flash v2.5 for latency) on the final answer → `amelia_audio` SSE event with audio URL → phone plays it. This is the ElevenLabs-prize surface: agentic depth + low latency + multimodal. (5) Email: draft only, show in app, tap to send via Resend from owned domain. Never auto-send. (6) Press-and-hold manual summon fallback — REQUIRED, it is the stage net for a failed owner voice match. (7) **At T+100 (3:10 PM) stop building.** Hand remaining Amelia work to whoever has slack. Own: 60-second video (shot list in `/video/shotlist.md`, below), 3-minute stage pitch, rehearsal. Canonical command that must work: "Hey Amelia, send an email to Jerry asking about his recent trip — I forgot where he went — and if he's already moved in, ask how it went. If he hasn't, ask how he's feeling about it." The conditional branch is the point.

**Skills:** `claude-api` (tool-use agent loop), `text-to-speech` (ElevenLabs TTS API + Flash model choice), `setup-api-key` (ElevenLabs key config), `unslop` (pitch + video script).

**Done when:** canonical command resolves trip from memory, branches on move-in date vs today, drafts correct email, speaks the reply; press-and-hold path identical.

### Lane E — Mentra Live glasses (stretch; starts only after T+150 golden-path gate)

**Owns:** `/server/glasses`. **Branch:** `lane-e`. Whoever has slack after the gate.

MentraOS Cloud SDK app (`@mentra/sdk`, `AppServer`/`AppSession`): register at console.mentraglass.com (package name + ngrok static URL, mic permission), `session.subscribe(StreamType.AUDIO_CHUNK)` → `onAudioChunk` delivers raw 16 kHz PCM server-side → feed the **same StreamBuffer path** as phone audio (glasses become a second capture device; zero Expo changes, zero native modules). Amelia's spoken reply through the glasses: `session.audio.speak(text)` — MentraOS TTS is ElevenLabs under the hood, which extends the ElevenLabs-prize story to the wearable. Reference template `Mentra-Community/MentraOS-Camera-Example-App`; use the `mentraos-docs` MCP server for every SDK lookup rather than guessing APIs.

**Demo framing rule (applies even if the code doesn't land):** glasses never lead the pitch — the differentiator is knowing who is in the room, not the wearable. No "ambient/always-on/second brain" vocabulary in the first 15 seconds. Answer "isn't this Limitless?" unprompted.

## Video — 60-second cut (Round 1 gate; Lane D owns; shoot 3:10–4:30)

Screen-record the phone via QuickTime/cable during a real exchange; one lav-less voiceover pass; every frame shows hackathon-built features only, and the README + video credit any pattern referenced from siyi as prior art.

| t | Shot |
|---|---|
| 0–8s | Hook over live transcript separating two speakers: "Every memory app records what was said. None of them know who said it." |
| 8–20s | Marquee: unknown speaker's bubbles accumulating → tap "this is… Jerry" → avatar persists, history attaches, profile fills |
| 20–32s | Supersession: Jerry's fact card "Moving in Aug 15" → new sentence lands → card flips to "Aug 20", chain visible ("updated from Aug 15") |
| 32–50s | "Hey Amelia…" canonical conditional command; her live trace steps stream inline; draft email appears; she answers **out loud** |
| 50–60s | Promise fires as a lock-screen notification; end card: "Amelia — memory that knows who's in the room. MongoDB Atlas · $vectorSearch · $rankFusion" |

## Task→model delegation

| Task | Model |
|---|---|
| Lane A audio spine | Human + Opus (streaming/buffer code is the hard part) |
| Lane B schema/indexes/extraction | Opus (schema + supersession logic), Sonnet for CRUD endpoints |
| Lane C app screens | Sonnet (spec is fully fixed; scoped single-file components), Opus for conversation-view re-label animation |
| Lane D Amelia loop | Opus (agent loop + branching), Haiku for pitch copy polish |
| Lane E glasses | Sonnet (template-driven, docs via MCP) |
| Video editing | Human |

## Verification

- **T+50 gate test:** script POSTs `/fixtures/transcript.json` line-by-line to `/debug/utterance` → utterances appear in Atlas (`mongosh` count) and in the app with ≥2 distinct speakers. **T+100 gate test:** `REPLAY=1 bun server` runs the real WAV through pyannote + Realtime + StreamBuffer to the same result, then live mic.
- **Golden path script (run at T+150 and again at T-60 dry run):** (1) live 4-person conversation separates speakers; (2) enrol nobody for speaker 3 → Unknown appears with identicon → tap-name → history attaches; (3) say "actually my move got pushed to September 2" → fact card updates, old fact chained; (4) ask "where is Jerry moving?" → cited answer reflects Sept 2; (5) canonical Amelia command → correct branch → draft → spoken reply; (6) "I'll send you that PDF tonight" → Loops entry → notification fires (set fire_at ~2 min out for the test).
- Each lane's Done-when criteria above are its acceptance tests; nothing merges to main at a gate without them.
- Eligibility check before submission: repo public, Atlas Hackathon Sandbox URI in use, README's "built during the hackathon" section lists original contributions and credits the siyi-referenced patterns.
