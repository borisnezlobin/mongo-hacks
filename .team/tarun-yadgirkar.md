name: tarun-yadgirkar
status: active
updated: 2026-08-15T23:40Z

## Now

Speaker attribution, on the scoring side rather than the audio side.

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
