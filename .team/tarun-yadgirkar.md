name: tarun-yadgirkar
status: active
updated: 2026-08-15T23:50Z

## Now

Driving the profile-tools half of stream 3. The voice half is still unclaimed.

`set_name` and `set_birthday` are in Amelia's tool surface. Both go through the
append-only fact path rather than beside it, so a birthday corrected out loud
supersedes like every other fact and `resolve_fact_state` reads back the current
one — `birthday` is in that tool's controlled vocabulary now, which it had to be
or the write would have been unreachable. Both refuse an unresolved person
rather than writing a fact nobody can reach or renaming nobody and reporting
success.

Before that: speaker attribution, on the scoring side rather than the audio side.

Landed `server/identity/score-norm.ts`: adaptive score normalization (AS-norm)
plus logistic calibration, EER, and a three-way speaker decision. Not wired into
`attributeSpeaker` yet — it is pure functions over scores, tested on its own,
and the integration is the next commit.

The reason it exists: raw cosine is not comparable across speakers. A generic
voice scores well against half the database, and one global constant cannot say
that 0.55 is remarkable for one person and unremarkable for another. That is a
structural reason a fitted threshold does not survive a new room, not a careless
one — so fitting a fresh constant to a bigger fixture would not fix it either.
AS-norm scores a trial against the people it is definitely not, from both sides,
and reports deviations above that background, which makes one threshold hold
across speakers.

`bun run eval:score-norm` measures raw against normalized. With no arguments it
simulates the one effect AS-norm removes and says so in its own output; on that
simulation EER goes 25.0% -> 8.3%. That is a demonstration that the mechanism
works on the failure it targets, and it is **not** a claim about ECAPA. Pass
`--embeddings <file>` for the real measurement.

## Heads up

- **`shared/contracts.ts` changed — re-pull before you build against MemoryApi.**
  It gained `setFact(personId, attribute, claim)` and `namePerson(personId,
  name, relationship?)`, landed as their own commit ahead of the tools that call
  them. Anything implementing MemoryApi has to implement both; the two in the
  tree (`server/memory/index.ts` and `server/amelia/fixture-memory.ts`) already
  do. `setFact` is deliberately not a general-purpose writer — the attribute has
  to be one `resolve_fact_state` can read back, or you have written something
  unreachable.
- **`store.setFact` has no test and cannot get one here.** It needs Mongo, and
  `db.ts` throws on first access without `MONGODB_URI`, so there is no harness
  in this repo to hang it on. Everything asserted about supersession — create,
  supersede, the same-value no-op, the A→B→A revert — is asserted against
  `fixture-memory.ts`, which I made match the implementation deliberately and
  which is therefore not independent evidence that the implementation is right.
  The supersession chain in Mongo is unverified. Worth an integration harness
  (mongodb-memory-server, or a suite gated on a real URI) before trusting it,
  and that gap is not specific to setFact — nothing in `server/memory/store.ts`
  is covered today.
- **`set_birthday` takes an id, not a name, and the double is more forgiving
  than production.** `fixture-memory`'s `getPerson` matches on `_id` or a
  case-insensitive name; `store.getPerson` queries `_id` only. So passing
  "Maya" works in tests and returns an error against the real store. That is
  the intended production behaviour — the tool description says an id — but do
  not read the passing test as proof a name works.
- **Two of Amelia's tools now WRITE.** Everything before this only read. The
  only thing between a stranger's voice and a write is the wake gate, which
  admits the owner at `OWNER_AUTH_THRESHOLD` — described in `wake.ts` as
  deliberately the looser threshold, and currently the same 0.6 as ordinary
  attribution. `PLAN.md:70` had them at 0.75/0.60 before attribution dropped and
  closed the gap. It is also the one threshold with no env override, so it
  cannot be tightened at a venue. I have not changed it — that is stream 1's
  call and it wants a decision rather than a quiet edit — but it should be
  stricter than attribution, not looser, now that acting as the owner can change
  what a person is.
- **`bun run test` was lying if you had a worktree.** There was no vitest
  config, and vitest's defaults exclude `node_modules` and `dist` but know
  nothing about `.claude/worktrees/`, where agent worktrees put a second full
  checkout. With one present the whole suite collected twice — I saw 369 tests
  "pass" against a real 194, half of them from somebody else's branch at a
  different commit. Added `vitest.config.ts` for the exclude and a `.gitignore`
  entry, because vitest does not read `.gitignore` and git was one `git add -A`
  away from committing an entire nested checkout. If your counts jump, that was
  why. I left `.claude/worktrees/todo-sweep` alone — it is locked and it is
  someone's in-flight work.
- **Three new env vars, all off by default.** `IDENTITY_MARGIN_COSINE` (default
  `0`) is the master switch: above 0, `attributeSpeaker` returns
  `{status:'pending',reason:'ambiguous'}` when the two best candidates are
  DIFFERENT people sitting closer together than the margin, instead of coin-
  flipping between them. `ATTRIBUTION_RETRY_SPEECH_MS` (default: the effective
  `EMBED_MIN_MS`) is how much pooled speech must accumulate before the session
  re-attempts an ambiguous speaker — without it `maybeAttribute` would re-embed
  on every 100 ms frame, on the ingest promise chain. `ATTRIBUTION_MAX_ATTEMPTS`
  (default `3`) caps those retries, after which the speaker is decided the way
  main decides today. At `IDENTITY_MARGIN_COSINE=0` nothing above is reachable
  and behaviour is byte-identical, including the `$vectorSearch` pipeline and
  the `people.findOne` count.
- **The attribution numbers in this repo are about macOS system voices.** The
  eval fixture is 43s of `say` output from four voices picked for separability
  (`fixtures/generate_audio.py:11-13`), padded with exact digital silence, with
  zero overlap and oracle turn boundaries. `generate-fixture.py:11-16` already
  says this. Worth knowing before anyone tunes a threshold against it: the 24%
  baseline is arithmetic, not a measurement — 19 of 25 turns are under the
  3000 ms floor and auto-`unattributed`, so 24% was its ceiling by construction.
- **Nothing measures the open-set decision.** Every eval speaker is enrolled,
  there is no held-out imposter, and the verdict space has no "correctly
  rejected" state — so rejecting is always scored as wrong and the harness
  unconditionally rewards a lower threshold. That is backwards from production,
  where a low threshold glues a stranger onto an existing person.
- `ATTRIBUTION_THRESHOLD` and `OWNER_AUTH_THRESHOLD` are both 0.6, and
  `wake.ts` describes owner auth as deliberately the loose gate. `PLAN.md:70`
  had 0.75/0.60; attribution dropped and the gap closed. Owner auth is what
  authorises the agent to act, and the profile-update tools in stream 3 make it
  a write path — it should be stricter than attribution, not looser. It is also
  the one threshold that is not env-overridable.
- **The sidecar is not reproducible.** `from_hparams` has no `revision=` pin and
  `requirements.txt` is seven unpinned names. A reinstall, or an upstream push
  to the HF repo, can change the embedding — at which point stored voiceprints
  stop matching new ones with no error, only gradually worse attribution. Worth
  pinning both and stamping a model version on each voiceprint document.
- `sidecar/app.py:56` divides by the L2 norm with no epsilon, so all-zero audio
  yields NaNs that propagate into cosine scores silently. Reachable: the eval
  fixture is padded with literal digital zeros.
- `bun.lock` was missing `expo-file-system` and `ws`, both of which are declared
  in the workspace `package.json` files. `bun install` corrected it and the fix
  is in this commit — a fresh clone would otherwise have resolved differently.
- `namePerson` and `mergePeople` each exist twice, in `server/identity/` and
  `server/memory/`, both mounted on the same routes; identity wins only by
  registration order in `server/index.ts:75-79`. They disagree on what an
  unnamed person is (`'Unknown'` vs `''`), and `createUnnamedPerson` has no
  callers. Not touched, but somebody should delete one side.
- `utterances` has no `{owner_id, person_id}` index, and both `namePerson` and
  `mergePeople` query by `person_id`. Every rename is a collection scan.
