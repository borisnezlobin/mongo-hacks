name: borisnezlobin
status: active
updated: 2026-09-04T00:00Z

## Now

**Two streams, both starting now (2026-09-04).**

Stream 6, glasses and the identity frontier. Voice alone has been the weak
part of this product, so the glasses add a camera and identity becomes two
independent identifiers instead of one. A XIAO ESP32-S3 on the frames runs a
softAP, the phone relays its audio into `/stream` unchanged, the phone finds
faces and lips locally, and the server embeds the crops and matches them in
process the way voiceprints already match. Either identifier can confirm
alone; together they multiply; confidently disagreeing is a merge question for
a human. A confirmed face teaches a voiceprint, which is how somebody
recognised across the room gets enrolled without ever being asked. Idle faces
are match-only — outside a conversation nothing is minted or stored. Presence
lands in the app as a card with a name and when you last talked.

Stream 7, the app redesign, on a shattered-glass system with a red-orange
accent: Skia shards over a hot panel, Reanimated motion, Blender for the
geometry. Palette is picked from mockups before any screen is built.

P0 contracts and schema are on main. Firmware, the faces lane, and the app's
pure modules come next.

Rebuilt the speaker-ID and transcription core. Landed on main.

- Speakers are clustered before they are attributed. Attribution used to be
  structurally impossible for any turn under 3s, which is most of conversation;
  it now runs once per speaker cluster on pooled audio. 24% -> 92% on the eval
  fixture, 0% -> 85% for turns under a second.
- Partial transcripts stream from realtime deltas instead of waiting for a turn
  to complete.
- `eval/` measures attribution accuracy bucketed by turn length. Run it before
  touching any threshold — the old 0.6 was fitted to one seven-turn fixture in
  which nothing was short, which is how the stage demo failed.

Next, undecided: an on-device pipeline (sherpa-onnx, cross-platform) versus
ElevenLabs Scribe v2, whose batch diarization scored 100% on the same fixture.
The blocker is whether its speaker library supports retroactive enrollment from
conversation clips — we can never ask someone we just met to record a sample.

## Heads up

- **`shared/contracts.ts` grew a face and glasses half (2026-09-04).** All
  additive, nothing existing changed shape. Two new events on the `AmeliaEvent`
  union — `presence` and `identity_conflict` — so **any reducer or switch over
  event types has to accept `presence`** or a person walking into the room
  falls on the floor. Also `Person.avatar_thumbnail` and `Person.last_seen_at`
  (denormalised so `GET /people` carries the avatar and no screen needs a
  second call), `Voiceprint.taught_by`, `StreamHandshake.capture_mode`
  (optional; absent is today's behaviour), `Faceprint`, `FaceClaim`,
  `FaceObservationRequest`/`Response`, `OwnerCheckResponse`, `MergeCandidate`,
  and `Calibration`, which moved out of `server/identity/score-norm.ts` — that
  file re-exports it, so imports still resolve.
- New routes in `ApiContract`: `POST /faces/observe`, `POST
  /audio/owner-check`, and `GET /people/duplicates`, which has existed on the
  server the whole time and was simply missing from the contract.
- The firmware-to-phone wire protocol is declared in contracts too
  (`GLASSES_FRAME_AUDIO`/`JPEG`, `GlassesAudioFrame`, `GlassesJpegFrame`,
  `GlassesHello`, `GlassesStatus`, `GlassesControl`), because the board and the
  phone are two languages that have to agree byte for byte and this is the only
  file both sides read.
- **`faceprints` collection**, with one ordinary index (`faceprints_by_person`)
  and deliberately **no search index** — the Atlas allowance of three is spent,
  so faces match in process. `db/indexes.test.ts` now fails if someone adds a
  fourth.
- `package.json` gained `eval:faces`. The face thresholds in contracts are
  placeholders until it has been run on real crops.
- **Coming soon and worth bracing for: the app gains native modules** — Skia,
  Reanimated, Gesture Handler, and two local Expo modules (hotspot join, Vision
  face landmarks). That means a dev-client rebuild for everyone, not just a
  `bun install`. It will land as its own commit with a line here on the day.
- **This is the day: the app gained `@shopify/react-native-skia` 2.6.2,
  `react-native-reanimated` 4.5.1, `react-native-worklets` 0.10.1,
  `react-native-gesture-handler` 2.32.0, `expo-image` 57.0.4, `expo-font`
  57.0.3, and the Schibsted Grotesk and Instrument Serif font packages.**
  `bun install` is not enough — **everyone must rebuild the dev client**:
  `cd app && npx pod-install && npx expo run:ios --device`. **The client you
  have installed will crash on the new bundle**, because it has no Skia,
  Reanimated or Gesture Handler native code in it. `app/babel.config.js` is new
  and preset-only; `babel-preset-expo@57` registers the worklets plugin itself,
  so do not add it, and start Metro once with `npx expo start -c` after
  rebuilding. Root `package.json` gained `trustedDependencies` for
  `@shopify/react-native-skia` — without it Bun skips the postinstall that
  downloads the Skia binaries and `pod install` fails. `App.tsx` now loads the
  new fonts alongside Manrope and Newsreader and wraps the tree in
  `GestureHandlerRootView`; `expo install` also added the `expo-image` and
  `expo-font` config plugins to `app/app.json`.
- `shared/contracts.ts` gained `speaker_pending` and `conversation` events, and
  now `UtteranceEvent.superseded` — the final pass rebuilds the transcript from
  a whole-file transcription and a handful of live lines have no counterpart in
  it. A client that ignores the flag will show stale rows under a corrected
  transcript; `app/src/state/reducer.ts` drops them.
- **Speaker attribution is pyannote now.** The final pass transcribes the
  retained WAV with whisper, diarizes it with `pyannote/speaker-diarization-3.1`
  in the sidecar, and joins the two at word level. `diarize-client.ts` and
  `label-stitch.ts` are deleted, `attribute-recording.ts` is rewritten, and
  `AUDIO_FINAL_PASS` is now on/off rather than diarize/whisper. The sidecar
  needs `HF_TOKEN` for the gated weights and reports `diarization` on
  `/health`; without it identity still works and the final pass declines.
- **`POST /replay/start` is gone.** It wrote invented conversations and people
  into the real database. Use `bun run eval:attribution` instead — it measures
  the pipeline offline without touching anyone's data.
- The audio path no longer dies when Atlas is unreachable; it degrades to
  emit-only. Note the memory lane still holds its own Mongo client, so a server
  started while Atlas is down stays half-dead until restarted.
- Synthetic and corrupted rows were purged from Atlas: fixture people
  (`p-maya`, `p-jules`, `p-priya`), replay conversations, 6 orphaned
  voiceprints, and the facts and promises hanging off them. 15 real
  conversations and 4 real people remain.
- `app/src/lib/store.tsx` gained `attributing`, `renamedConversations` and
  `avatars` state, and now exports `reduce` for tests.
- **`GET /review` exists**: a local-only transcript review page, registered from
  `server/index.ts` (one added import and one `registerReviewRoutes(app, deps)`
  line). Everything else it needs lives in `server/review/`. Click a line and it
  plays that span of the wav — spans are cut by byte offset out of the source
  file and served as their own small wav, which is why a click 39 minutes into
  the recording still starts in single-digit milliseconds. The owner's
  corrections go to `eval/real/corrections.json`, which is gitignored
  (`.gitignore:43`, confirmed with `git check-ignore`), and the writer refuses
  to write anywhere git can see. Do not expose this server: the page serves real
  speech and the corrections quote it.
- `eval/owner-corrections.ts` turns those corrections into landmarks and span
  reference, and `eval/diarization.mts` prints them. `eval/landmarks.ts` is
  untouched — folding the generated set into `checkLandmarks` would be a
  one-line signature change (`checkLandmarks(recording, segments, landmarks =
  LANDMARKS)`), worth doing next time that file is open. Until then
  `mergedLandmarks()` does the merge, including folding case, because
  `landmarks.ts` writes 'volva' and the app writes 'Volva'.
- **The review page can now split a line and undo a ruling.** Two fixes worth
  knowing about beyond the features. First, saving a correction no longer
  answers 409: amending your own earlier ruling was being treated as a
  contradiction, so once you had edited a line's words you could not edit them
  again *or confirm the line as-is*. Supersession is not disagreement.
  Contradictions with `eval/landmarks.ts` are still recorded and shown, but as a
  banner beside the line with undo next to it, never a dialog that refuses the
  write. Second, a landmark name is only compared against a correction when this
  conversation actually knows that name — `landmarks.ts` spells the Ukrainian
  "volva" and the pipeline guessed "Vova", which flagged a false contradiction
  on every line he speaks. Rename the person and real mismatches surface again.
- Splits are stored separately from corrections because they claim something no
  per-line attribution can: *a speaker change happened here*. `ownerBoundaries()`
  and `scoreBoundaries()` in `eval/owner-corrections.ts` measure that against a
  system's emitted turn boundaries, which is a number this repo could not
  produce before — pyannote scores 0/2 on the first split line, delivering
  18.22-24.38 s as a single turn. Cuts are stored as the silence they sit in,
  not as an instant, because nothing in the audio narrows it further.
- **The review page now leads with what is worth most, not with 00:00.** Three
  things landed. (1) Same-or-different questions from `ground-truth.json`'s
  `to_resolve`: one answer settles ~457s, where a line correction settles a
  line. `server/review/questions.ts` builds them; note the builder writes clips
  for the FIRST label only and `at` is the clip start, and resolving those
  timestamps by containment returns the wrong labels (0:A and 0:G for a question
  about 0:E) because segments overlap — only an exact start match is correct.
  The rival side's clips are chosen here. (2) A prioritised queue
  (`server/review/queue.ts`), default, with sequential one click away. (3)
  Correction anchoring (`server/review/anchor.ts`) re-keys by time and words
  instead of line id, and refuses to merge two disagreeing corrections onto one
  line — the thing that only worked last time because both happened to say Volva.
- Two ranking signals were measured and **dropped**: `overlappedWords > 0` fires
  on 75% of lines and "spans more than one pyannote speaker" on 70%, so neither
  ranks anything, and `identity_confidence` is the literal constant 'confirmed'
  on every stored line. What survived is speaker deficit weighted by speech
  held, the top-two speaker margin (p10 0.00, p50 0.56, p90 1.00), turns under a
  second, and timeline spread. The queue is two-phase: a voice with no ground
  truth is offered its longest, cleanest turns, because a 300ms "yeah." cannot
  identify a stranger; once pinned, short and contested turns rank up instead.
- `identityLandmarks()` uses union-find over the `same` answers. Do not make it
  per-question: all three questions here share one rival label, so per-question
  identities stamped contradictory names on identical spans and demanded a span
  differ from itself.
- **Identity answers are anchored to audio spans, not cluster ids.** The
  questions come from `ground-truth.json`, whose labels (`0:E`, `950:E`) are
  chunk-scoped names from the retired provider; the product now emits global
  SPEAKER_00..07. Each answer therefore stores `compared` — the two stretches he
  was actually played — and `identityLandmarks` does union-find over span keys,
  producing identities like `voice@1696.1s`. Verified the constraints are
  byte-identical with the question set present and with it removed entirely, so
  regenerating the question set cannot silently delete his answers. `label_a` /
  `label_b` stay on the record as provenance and must never be keyed on.
- An answer constrains **only the two stretches he heard**, not all three clips
  a side. The clips on one side are one voice only according to the retired
  clustering, and these clusters are in the question set precisely because that
  clustering marked them impure — grouping them would answer the question being
  asked. Fewer constraints, all of them his.
- `worth_seconds` is an estimate from the retired clustering's span assignment,
  and the UI now says so. Do not quote it as a measurement.
- **The review page is responsive now; he was using it on a phone.** One
  stylesheet with a `max-width: 760px` block, not a second page. On a small
  screen the identity question comes first (it is the best thing on a phone:
  two clips, three buttons), the roster and coverage strips become single-line
  scrollers, the transcript drops to a two-column grid with the text clamped to
  two lines until selected, and the panel becomes a capped bottom sheet whose
  speaker picker is one swipeable row instead of eight full-width ones. Every
  keyboard shortcut has a button — `prevLine`/`nextLine`/`editWords` were added
  for the ones that had none — and `server/review/page.test.ts` asserts that,
  because keyboard-only affordances are what made it unusable.
- **`clock()` was declared twice in the page script**, once taking milliseconds
  and once taking seconds. Declarations hoist, so the later one silently won
  every call site and the picker printed "12562m10s" for a voice in a 48-minute
  recording. Duration formatting now lives in `server/review/format.ts` as
  `msToClock` / `secondsToClock`, is injected into the page from there so there
  is one implementation, and a test fails on any duplicate function declaration
  in the page script.
- Watch for backticks in comments inside `page.ts`: the page is a `String.raw`
  template, so a backtick in a comment terminates it. `tsc` catches it, but the
  error points at the wrong line.
- **Rulings advance the queue now.** Nothing did before: every handler saved and
  returned, leaving him on the line he had just finished with no signal it had
  worked — on a phone, indistinguishable from a failed save. Terminal actions
  (naming the speaker, Correct as-is, recording a split, answering a question)
  save and move to the next unruled line, autoplay it, and report what was saved
  plus why the next one is being asked. **Saving words is deliberately not
  terminal** — editing text then naming the speaker is two rulings on one line,
  so words save in place and ask for the speaker, unless the speaker is already
  settled. Undo never advances and walks back to the line his last ruling landed
  on, because by then he is standing on the next one.
- Running out of queue shows a card offering the voice questions or a read in
  order, rather than silence. On a phone the page now opens on the questions and
  the line list is a header toggle away.
- Watch out: a `page.ts` edit that silently does not match is invisible — the
  first attempt at the advance handlers replaced nothing and typechecked clean,
  and only driving the page caught it. Assert on every string replacement.

## Cross-recording identity, measured (2026-08-20)

Measurement only — nothing shipped changed, and `shared/contracts.ts` was not
touched. New tools all live in `eval/real/`:

- `cross-session-identity.mts` plays all four real recordings through the
  shipped `assignClusters` in order and prints the people the product would
  have ended up with. **0 false merges** at every threshold from 0.55 to 0.75.
- `model_transfer.py` scores pooled clips across recordings, over a ladder of
  pool sizes and three embedder lineages. With the shipping ECAPA, cross-
  recording only, 1,620 trials:
    8 s   same p5 0.325 median 0.541  |  different max 0.513  -> 97% missed at 0.68
    20 s  same p5 0.587 median 0.712  |  different max 0.621  -> 33% missed at 0.68
    60 s  same p5 0.781 min    0.764  |  different max 0.627  ->  0% missed, 0% false
  `ATTRIBUTION_THRESHOLD` 0.68 is right, and sits in the middle of the 60 s gap.
  `CONFIRMED_SPEECH_MS` at 20 s is not: it was measured inside one recording,
  where both sides share a room, and cross-recording linking needs about 60 s.
  Do not change the constants on this alone — the argument is in the report.
- `cluster_pools.py` builds pooled-AUDIO voiceprints per cluster, which is what
  the product holds.
- **Correction to an earlier claim of mine.** I first reported that averaging
  per-turn vectors is worse than embedding the joined audio (0.44 versus 0.72,
  same person, same seconds). Measured properly with `pooled_construction.py`,
  which holds members, seconds and queries fixed and varies only the joining,
  the two are equal — concat never beat mean on AUC at any clip length or pool
  size. The real variable is **how many members the average has**: every
  turn-averaged model with 50+ turns scores 0.86-0.95 against the same person in
  another recording, and the only ones that collapse are dorm-9pm's, which have
  7-15 turns behind them. Averaging is fine; averaging almost nothing is not.
  `pooled_floor.py` was never at risk — it averages 4-20s SPAN embeddings, not
  turn vectors, and its duration floor is unmoved.
- `turn_embeddings.py` gained `TURNEMB_SUFFIX` so a second embedding model no
  longer silently overwrites the wespeaker cache every other script reads.

Two identities were recovered from the transcript rather than from voices:
**jerry-45min/SPEAKER_04 is Boris** (says "Jerry" to somebody else six times)
and **jerry-45min/SPEAKER_03 is Tarun** (says "Boris" to somebody else three
times, and matches the owner-labelled Tarun spans at 0.88). The Tarun one is now
**owner-confirmed** — he identified the GBO check-in line as Tarun's — so the
dorm-40min -> jerry-45min link at 0.897 is a true link. Tarun in the Jerry
recording is a fourth appearance nobody had recorded. SPEAKER_04 as Boris
remains a hypothesis, though a well-supported one: it matches the
landmark-grounded `dorm-9pm/boris` at 0.788.

### What the speech-duration constants actually gate (2026-08-20)

Read the call sites before acting on the turn-length statistics. It is true that
~80% of turns and ~30% of speech are under 3 s (counted independently, the
numbers reproduce exactly). It is **not** true that `EMBED_MIN_MS` drops them.
Both attribution paths gate the speaker's POOLED speech, not the turn:

- `server/audio/session.ts:501,511` live pass — `speakersOverFloor(embedMinMs)`
  and `buffer.speechMsFor(speaker)`, then embeds `buffer.audioFor(speaker)`.
- `server/audio/session.ts:999` final pass — `speechMs.get(speaker)`, then
  embeds `audioForSpans(spans)` over all of that speaker's clean turns.

So a speaker with thirty sub-second turns totalling 25 s clears the gate on the
pool. `EMBED_MIN_MS` only excludes a person whose entire pooled speech in the
session is under 3 s. Short turns are not unattributed — they inherit their
cluster's identity. The thing that actually misfiles them is the diarization
putting them in the wrong cluster, which is the within-recording clustering
problem, not this constant.

`PROVISIONAL_SPEECH_MS = 8_000`: defensible within a session, unusable across
recordings. At 8 s of pooled speech on each side, cross-recording same-person
cosine is p5 0.325 / median 0.541 against a different-person max of 0.513 —
**97.5% of genuine links missed at 0.68**, and no threshold separates them.
Anything cross-session needs ~60 s.

### ECAPA vs wespeaker at pooled assignment — settled, no change warranted

`eval/real/short_query_assignment.py` runs both on byte-identical audio, the
identical pool membership, identical query cuts and the identical held-out rule
(every clip list is chosen before any model is loaded). Gallery of 7 voices,
top-1 % on dorm-40min, n=80 per cell so read ±5:

  pools                      model      0.5s   1s    2s    3s
  reference, uncapped ~176s  ECAPA       81    69    91    90
  reference, uncapped ~176s  wespeaker   68    70    89    91
  reference, capped 20s      ECAPA       56    52    69    74
  reference, capped 20s      wespeaker   55    58    70    71
  cluster-built 20s          ECAPA       46    45    51    55
  cluster-built 20s          wespeaker   40    35    38    42

Within a few points everywhere, neither ahead consistently. The 88-vs-70 gap
that prompted this was not the embedder — it was pool size and gallery
composition. **Do not switch what we embed with; there is nothing there.**

Worth knowing while reading the above: **ECAPA is already the shipping identity
embedder** (`sidecar/app.py` loads `speechbrain/spkrec-ecapa-voxceleb`,
`EMBED_DIMS = 192`, matching `VOICEPRINT_DIMS`). wespeaker is the eval tooling's
default `SPK_MODEL` and what pyannote-3.1 clusters with internally. So the seam
is real — diarization clusters with one model, identity stores another — but the
two measure as equivalent at this task, so it is not currently costing anything.

What the same table shows about pools: **size dominates cleanliness.** Capping
clean pools from ~176 s to 20 s costs 25 points at 0.5 s (81 -> 56); making them
dirty costs a further ten (56 -> 46). Confidently-wrong stays at 0-5% in every
cell and is 0% at 0.5-1 s, and at `ATTRIBUTION_THRESHOLD` 0.68 essentially
everything under 1 s abstains rather than guessing.

### The duplicate-person problem: proposal, not built (2026-08-20)

Measured first. Three results decide the shape, and the second one moves the
fix somewhere other than where it looks like it belongs.

**1. A floor on minting is the wrong lever — measured with `eval/real/floor_cost.py`.**
Pooled speech per diarization cluster, all four recordings, 21 clusters:

  floor    clusters clearing it      share of speech
    8s     21 of 21 (100%)               100%
   20s     20 of 21 ( 95%)              99.7%
   60s     14 of 21 ( 67%)              95.1%
  120s      9 of 21 ( 43%)              88.0%

A 60 s mint floor leaves a third of voices permanently unresolved, and **all
three people in dorm-9pm never clear it** — a three-minute conversation would
end with nobody identified at all. Even for those who do clear it the wait is
7-20 minutes into the conversation (Boris hits 60 s at 7.7 min in dorm-40min,
11.1 min in mentra-mtg). The distribution behind the floor is right; the floor
is wrong.

**2. Only the ENROLLED side needs the speech.** `model_transfer.py` now reports
the asymmetric matrix. Cross-recording, ECAPA, miss rate at 0.68:

  enrolled \ query      20s        60s       120s
        20s          18.5%       1.7%       1.7%
        60s           1.7%       0.0%       0.0%
       120s           1.7%       0.0%       0.0%

False accept is **0.0% in every cell**. The 18-33% miss figure I reported was
20s against 20s — both sides starved. A print backed by 60 s recognises a 20 s
cluster with 1.7% miss. So the bar belongs on **what gets stored as a
voiceprint**, not on when a person may be created.

**3. Eviction throws away the best evidence.** `selectEvictions`
(`matcher.ts:251`) sorts by `created_at` only; `EvictablePrint` does not even
carry `duration_ms`. So a 300 s print from a long dinner is evicted before a
20 s print from last week, and by the table above that swap is worth ~17 points
of miss rate.

**Proposed shape, for review before anything is written:**

- Keep minting where it is (`CONFIRMED_SPEECH_MS`). A person minted from 20 s is
  correct *within* the session, and the session is where facts are filed.
- Gate `reinforce` on `CROSS_SESSION_SPEECH_MS` instead: below 60 s of pooled
  speech, do not store a print. A weak print is what causes next session's
  duplicate, so not storing one is strictly better than storing one.
- Make `selectEvictions` prefer keeping the longest-pooled prints, not the
  newest. Needs `duration_ms` on `EvictablePrint`; no new constant.
- Reconcile after the fact rather than withholding. `mergePeople` already does
  the hard part correctly (keeps oldest, re-points voiceprints, utterances,
  facts and promises, deletes losers, re-emits identity per conversation). With
  0% false accept across every pool size measured, a periodic pairwise sweep
  over people's prints can surface duplicates for one-tap confirmation with
  near-zero risk of proposing a wrong merge.
- `namePerson` should keep overriding all of it. It already stores an enrolled
  print at any duration and enrolled prints are never evicted — that is correct
  and is the escape hatch for everybody who speaks for thirty seconds and leaves.

Open question I could not settle by measurement: whether the merge sweep should
propose or act. 0% false accept was measured on 10 labelled voices in 4
recordings, which is not enough to justify acting unattended.

### Built: what earns a voiceprint, what gets evicted, and a merge sweep (2026-08-20)

`server/identity/**` only. Suite 894 passed / 5 skipped (was 880/5), `tsc` clean.

- **`reinforce` gated on `CROSS_SESSION_SPEECH_MS`**, with one exception that is
  not a hedge: a person with NO print always gets one, whatever the duration.
  The asymmetric matrix says a 20 s print still recognises a 60 s cluster at
  1.7% miss, while no print misses 100% and guarantees the duplicate the gate
  was meant to prevent. Something beats nothing. The contract comment's
  "declining to store one is strictly better than storing it" is true only when
  the person already has one — worth a word when you next touch it.
- **`storePrint` split out of `reinforce`** so the create path is typed as
  always producing an id. `AttributionResult.voiceprint_id` stays required and
  `server/audio/session.ts` needed no change.
- **`selectEvictions` drops the thinnest print, not the oldest**, tie-broken by
  age. `EvictablePrint` gains `duration_ms`.
- **`insertPrint` never evicts the print it just wrote.** Without this, storing
  a print for somebody whose existing prints all hold more speech deleted it
  inside the same call and left every utterance in the session pointing at a
  voiceprint that no longer existed. Recency also carries the only estimate of
  the room the speaker is in now.
- **`server/identity/duplicates.ts`** — `mergeCandidates`, pure, read-only,
  exposed as `GET /people/duplicates`. `POST /people/merge` remains the only
  writer. Skips pairs the owner has given different names.

**Measured after, on the four recordings.** Prints written: 20 before, 20 after
— the gate never fired here because almost every cluster is somebody's first
print. **0 of 17 people end up with no print; no cluster loses identifiability**,
so this is not your floor one step later. The rule bites only in a mature store,
where a known person speaks briefly: 6 of 21 clusters sit in the 20-60 s band.

**The sweep needed a guard, and the run is why.** With no minimum evidence it
proposed **Boris + Tarun at 0.681** — both prints from dorm-9pm, under a minute
each. The zero-false-accept result was measured on models holding at least 20 s
of pooled audio and does not extend below that, so `mergeCandidates` now
requires one side backed by `CROSS_SESSION_SPEECH_MS`. That drops the wrong pair
and keeps every genuine one, since a real duplicate always has one record built
from a long conversation. Remaining proposals: 6, all between clusters *inside
one recording* — i.e. the sweep is currently surfacing diarization splits rather
than cross-session duplicates, which is the within-recording clustering problem
again.

Not built, flagged instead: `applyDecision`'s no-match branch mints even when a
claim already owns those utterances, so an eviction mid-conversation could still
produce a same-conversation duplicate. Pre-existing, not introduced here, and it
changes minting — your call.
- **The phone view is now a single card, and the tool is not rendered there at
  all.** Below 760px `header`, `#ask`, `#cov`, `#people`, `main`, `#panel` and
  `#done` are `display: none`; `#card` fills the screen with exactly one
  decision. Question card: play A, play B, three answers. Line card: the
  sentence, play, eight voices, skip. Answering renders the next card. This
  replaced — not adjusted — the responsive layout, because he twice said he
  could not work the phone out and the second time was *after* everything
  already fit on screen. Fitting was never the problem.
- Removed with it: the whole `@media (max-width: 760px)` layout block, the
  `.mobonly` class, `#viewToggle`, `#prevLine`, `#nextLine`, `#editWords`,
  `#panelLine`, `setView()` and the `body.view-questions` states. A test asserts
  none of those names come back, so the two designs cannot both half-exist.
- Two bias fixes worth keeping: neither identity answer is styled `primary` (a
  recommended-looking "Yes" is a thumb on the scale in the one place we are
  admitting we do not know), and the line card *names* the pipeline's guess
  ("We think it was Boris") instead of ringing it silently — the suggestion is
  present either way, so it should be stated and refusable rather than decoded.
- Cluster ids never reach the card. `0:E vs 950:E` is retired bookkeeping and
  belongs in the file the answer is written to; a test guards it.

### An audit that started from a false alarm, and what it found anyway

`jerry-45min/SPEAKER_03 = Tarun` was reported as falsified and then confirmed.
The owner had been asked two identification questions in one message and
answered "tarun was not in the meeting" meaning the **Mentra** meeting; it was
read as the Jerry recording. His clarification: *"Tarun was present in Jerry's
dorm. he was not present at the meeting with Mentra. so yes, he did say that we
can check in for GBO in the morning."* The identification held. Four things the
audit turned up stand regardless, and three of them are worth more than the
scare was worth.

**1. The reference labels contradict the owner twice.** Checked against
`eval/landmarks.ts`, `dorm-40min`'s reference calls the line he identified as
**Dhruv** ("Drew.", 2317470) **tarun**, and the line he identified as **Clara**
(2466830) **boris**. Only one of the three in-range dorm-40min landmarks agrees
with it; all three dorm-9pm landmarks agree with theirs. **This is the reference
DER is computed against.** Flag it loudly wherever it is consumed, and prefer
`eval/landmarks.ts` whenever the two disagree.

**2. The trial count was inflated.** "0% false accept over 1,620 trials" was
never 1,620 independent trials — it was roughly 28 distinct speaker pairs
resampled six ways at three pool sizes. Resampling the same audio raises n
without adding information. Counting only pairs whose labels are owner-grounded
on both sides (`eval/real/identity_audit.py`, 60s pools, ECAPA):

  same person, across recordings   0.866 HIT   |  0.649 MISS
  different people, across         0.436 0.421 0.405 0.400 0.281
  different people, same recording 0.584 0.453 0.369

Eight impostor pairs, **none at or above 0.68**, maximum 0.584. Rule of three
puts the 95% upper bound on the false-accept rate at **38%** — no false accept
has been observed among grounded pairs, on a sample too small to claim a rate.
Two genuine pairs: one hit, one miss. Quote those numbers, not the old ones.

**3. `dorm-9pm/tarun <-> jerry-45min/SPEAKER_03 = 0.649` is a MISS.** Same
person, owner-confirmed on both sides, below threshold. That is not a
counterexample to anything — it is a real recall data point that corroborates
the thin-pool finding, because dorm-9pm yields only ~27s of Tarun and
thin-against-thin is exactly the cell where the asymmetric matrix says recall
collapses. It is also the strongest single argument for
`CROSS_SESSION_SPEECH_MS`: had a print been written from those 27 seconds, this
is the pair that would have minted a duplicate.

**4. `mentra-mtg` is two physical sources, not five people.** `SPEAKER_00` scores
near-orthogonally against every other voice measured (-0.09 to 0.19) and holds
1204s, 67% of the recording. The owner has confirmed Alex, David and Brendan
were **all remote**; only he and Jerry were in the room. So that cluster is a
laptop speaker carrying three people — one acoustic source, not one person. Five
systems reporting a 67% monolith were reporting the truth. **Do not use
`mentra-mtg` as evidence about in-room diarization**, and treat any per-speaker
measurement on it as measuring a channel rather than a person. My earlier
`mentra-mtg/SPEAKER_00 = Alex` should be read as "the remote channel", and the
gallery-7 figures that used mentra clusters as distractors are measuring
channel separation more than speaker separation.

  Consequence for another of my labels, flagged not fixed: I called
  `mentra-mtg/SPEAKER_03` **Brendan**, from a line thanking "Alex David Jerry
  Boris" (so the speaker is none of them). But Brendan was remote, and remote
  voices arrive on the laptop channel, SPEAKER_00. With only the owner and Jerry
  in the room and SPEAKER_02 being the owner, SPEAKER_03 is most plausibly
  **Jerry**. That is a hypothesis and wants the owner, not another 0.88.

### Standing rule for this file

An identification the owner has not confirmed is a **hypothesis**, whatever it
scored, and must be labelled as one wherever it feeds a measurement.

And its mirror, which is what actually bit here: **a refutation needs the same
provenance discipline as a claim.** This one looked confirmed, came from the
owner, and was an ambiguous answer to an ambiguous question. Before treating a
result as overturned, check that the question the owner answered is the question
that was asked — one recording named explicitly, one claim at a time.
- **The phone card now opens with what is waiting**, once: how many voice
  questions, how many lines, and what each is worth, with a Start button and
  "you are not expected to reach the end". Gated on a session flag so it never
  becomes a counter on every card. He asked to know whether he was facing three
  things or three hundred, which the single-card design had made unknowable.
- **"Something else is wrong"** opens the tools in place: fix the words, or name
  a voice that is in no list (`person_id: null`, which the store already takes —
  and which matters because the transcriber mangles names, and because a brand
  new recording has a roster of exactly one). **Splitting is deliberately not
  offered on a phone**: word-level cut points on a 390px column are ~15px
  targets that wrap across lines, and a mis-tap does not fail loudly, it records
  a speaker change at the wrong moment. "More than one person speaks here" files
  it for a laptop with that reason attached instead.
- Skips carry a `reason` now, shown on the desktop in the row badge tooltip and
  in the status line when the row is selected.
- **Bug worth knowing**: the phone card used `!line.ruling` to mean "unanswered",
  so fixing the words gave the line a ruling and the card skipped past it as
  though it had been attributed. It asks "who said this", so the test is
  `needsSpeaker()` — whether the SPEAKER is asserted, not whether anything is.
- `gbo-haas` arrives with no diarization, no landmarks, no reference and no
  questions, and the page handles it: questions [], landmarks 0, freshness
  `unknown`, queue falls back to speaker deficit and timeline spread. Note its
  whisper output has **no `segments`**, only words, so nothing has punctuation
  and the splitter offers no sentence suggestions on it.
- There is now a test asserting the page template contains no stray backticks.
  It has cost three debugging detours; `tsc` catches it but points at the wrong
  line. Also note `grep -c` counts matching LINES, not occurrences — that is why
  the earlier backtick checks looked clean when they were not.

## Whisper repetition loops eat real speech (2026-08-25)

Verifying the new eHub-at-Haas recording (`ehub-haas`, 160 min) turned up a
transcription failure that is not specific to it. **whisper-1's decoder gets
stuck repeating one line, and the loop stands where speech was.** Eleven runs in
that recording, 442 s of the transcript, the largest a five-minute stretch the
full-file pass wrote off as forty-two `🎵` markers. Re-decoding that stretch
alone returns 441 words of ordinary conversation — a student describing a
structural-engineering degree in France. It was not music. It is also not new:
`dorm-40min` has one four-long run at 35:18.

The repair is `server/audio/loop-repair.ts`, wired into `transcribeWithTimings`.
A run of three or more identical segments is a **suspicion**, not a verdict —
people really do say the same short thing several times, and a rule that cannot
tell the two apart is worse than the loop. So the run is decoded again on its
own, with 15 s of context either side, and whatever that decode says wins. A
fresh decode has no context to be stuck in, which is exactly why the first one
looped. Two of the eleven runs reproduced under an isolated decode and were kept
untouched; nine were replaced. Net +414 words of real text.

**The diarization corroborates it, and it never saw a word of text.** Over
85:41-90:54, the stretch whisper called music, pyannote finds 269 s of speech in
313 s with one voice holding 260 of them: a one-on-one conversation. Over
46:20-46:53, the twenty `I'm sorry.`, it finds **zero** speech and zero voices —
that was applause, and every one of those lines was invented. 125:38 comes back
at 145% coverage across five voices, which is crosstalk, and the re-decode reads
like crosstalk.

**Where the mechanism is weak, measured on the same evidence.** The isolated
decode is not an oracle. It only catches a loop that is a *decoder* fixed point;
a loop whose cause is acoustic reproduces on the second decode too and is kept.
Both kept runs are exactly that — `Thank you.` over applause at 17:23 and 43:23,
where pyannote finds 19% and **0%** speech. Eleven harmless lines here, but the
stronger verdict for this case is already in the pipeline: text over a span with
no diarized speech is not speech. Wiring that into the word join is the next
lever, and it needs care — pyannote missing speech must not delete it.

Also in this change:

- `transcribeOne` now returns the API payload rather than a `TimedTranscript`,
  and `transcribeRaw` is exported. Punctuation restoration happens once, at the
  end, in `readTimedTranscript` — the fixture files are verbose_json bodies and
  every reader restores punctuation itself, so a script that saved the processed
  shape would have it restored twice.
- `eval/real/transcribe.mts` produces `fixtures/real/<stem>.whisper.json` for a
  recording. Those fixtures used to be made by hand, one curl each, which does
  not survive a file over the 25 MB upload cap. Chunks and repair decodes are
  cached under `fixtures/real/chunks/` because each one is a bill.

## Heads up

- **Merging main superseded part of Tarun's ambiguity work, and he should know
  before he builds on it.** `1122dfe` wired `decideSpeaker` from the new
  `server/identity/score-norm.ts` into `identity/service.ts` and added an
  ambiguous-retry ladder to `audio/session.ts`, both against the pre-rewrite
  attribution path. This branch had already replaced that path with
  `identity/matcher.ts` (session-mean centering, greedy per-session assignment,
  `ATTRIBUTION_MARGIN` failing closed to `ambiguous`), so the two are the same
  idea implemented twice and they do not compose. The merge keeps this branch's
  version of `service.ts`, `session.ts` and their suites; `score-norm.ts`, its
  test and `eval/score-norm.mts` are untouched and still pass, but **nothing
  calls `decideSpeaker` any more.** AS-norm is the better answer to the problem
  the fixed margin only papers over, so the work to do is porting it onto
  `matcher.ts`, not reverting either side. His margin tests in
  `identity/service.test.ts` needed a `$vectorSearch` aggregate our fake
  collection deliberately does not have, and were dropped with that path.
- `server/audio/whisper-client.ts`: `transcribeOne` is raw now and the final
  pass makes extra API calls when a recording contains loops (bounded by the
  number of runs; zero calls when there are none). `repairLoops: false` opts out.

`ehub-haas` is now a complete fixture: `.wav` (+ `.stereo.wav`), `.whisper.json`,
`.pyannote.json`, `.sentpool.json`. 160 min, 31 voices, 277 s of simultaneous
speech, 2801 of 3001 sentences attributed. Two numbers worth knowing before
anyone promises a long recording: **pyannote ran at 0.9x realtime** — 3 h 6 m of
CPU for 2 h 40 m of audio — and whisper cost about a dollar. The opening keynote
minute lands 236 of 238 words on one voice, which is the cheap smoke test.

## The other half of the loop problem: nobody was speaking (2026-08-25)

The re-decode above catches a loop that is a fixed point of the *decoder*. It
structurally cannot catch one whose cause is acoustic — a fresh decode of the
same applause hears the same thing and the run reproduces, so it is kept. Both
runs left standing in `ehub-haas` were exactly that.

The diarization settles it and is already computed a moment later in the same
pass. `dropSilentRepeats` in `loop-repair.ts` removes a repetition run that
stands over a span where pyannote finds no voice at all; `session.ts` calls it
after `diarizeAudio` and before the sentence pass, so the join and everything
downstream never see it.

**Measured over every recording that has both a transcript and a diarization**,
which is what the 0.20 threshold is chosen from — `npx tsx eval/real/silent-runs.mts`:

| run | coverage | outcome |
|---|---|---|
| ehub 17:23 `Thank you.` x6 | 0.00 | dropped |
| ehub 43:23 `Thank you.` x6 | 0.03 | dropped |
| jerry 19:42 `David Wu.` x3 | 0.47 | kept |
| dorm 3:41 `I don't know when it's...` x3 | 0.87 | kept |
| ehub 17:32 `Thank you.` x3 | 0.91 | kept |
| dorm 27:59 `Merhaba.` x3 | 1.00 | kept |
| dorm 35:16 `Mechanical engineering.` x6 | 1.00 | kept |

Nothing sits between 0.03 and 0.47. Across the six recordings it drops 21 words,
all of them on eHub, and nothing at all on the other five.

**It is deliberately narrow and should stay that way.** Ordinary segments sit at
1.00 coverage at the median, but 1.3%-17% of them per recording fall under the
threshold — that is pyannote missing speech, and a rule that deleted those would
be deleting speech. Only a run that is already suspicious is put to the test.

## Personal data has one guard now

`server/lib/personal-data.ts` holds `assertPathIsGitIgnored`, moved out of
`review/corrections.ts` — the rule was never about corrections, and the moment a
second writer existed it needed one home. `assertCorrectionsPathIsIgnored` is
still there and still mentions `AMELIA_CORRECTIONS_PATH`; it delegates.

This came up because `eval/real/write-transcript.mts` renders a readable
transcript — every word real people said in a room — and `.gitignore` covered
`eval/real/*.json` but not `*.txt`. It would have been committed. The rule is
now `eval/real/*.txt`, and the writer checks `git check-ignore` before writing
rather than trusting the directory.

`eval/real/<stem>.transcript.txt` runs the whole final pass in `session.ts`'s
order — whisper payload, diarization, sentence pass, silent-run drop, word join.
`ehub-haas`: 1027 lines, 31 voices, 22701 of 22726 words attributed.

## The full-name announcement was disqualifying the name (2026-08-25)

Names are the point of Amelia, so this one matters more than the transcript work
above. On `ehub-haas` the naming pass offered 9 names for 31 voices. Three real
self-introductions were missed, and two of them for the same structural reason.

`collectNonPersonTokens` disqualifies a word that appears followed by another
capitalised word — the rule that keeps "Luma Links" and "Extended Reality" out
of the roster. **The other thing that is reliably two capitalised words in a row
is a person's full name**, and at an event the host says one before every single
speaker: "next up, Blockchain at Berkeley, Taj Sandhu." That one announcement
disqualified `taj` for the entire 160 minutes, so when he said "My name is Taj"
the pass produced **no mention at all** — not a weak one. Same for Alton
Sturgeon, who holds 1244 s, the second-largest voice in the recording.

The ordering was inverted: a guess made from capitalisation was vetoing the
strongest cue the system has. `selfNamedTokens` in `rules.ts` now exempts a word
somebody used to introduce THEMSELVES from that disqualification. It grants no
strength — an unfamiliar name still takes `UNFAMILIAR_NAME_FLOOR` and still has
to win on its own evidence, which is why Alton lands at 0.71 and Taj at 0.77.

Worth saying plainly: the filter only ever applied to names outside
`GIVEN_NAMES`, which is 1178 mostly-Anglo entries. It was quietly hardest on
exactly the people least likely to be recognised without it.

Measured across all six recordings, before and after: **the only change anywhere
is Taj and Alton appearing on `ehub-haas`.** Nothing else moves, and all 90
naming tests still pass. Four new tests, two of them guards — "Luma Links" must
still be kept out and "I'm Wizarding my freshman kids" must still not be a name.

### Still missed, and correctly

`Boris` is offered for nobody, and that is the right answer from where the pass
is standing. Two different voices self-introduce with it — SPEAKER_14 at 44:05
and SPEAKER_00 at 121:12 — at identical strength 0.78, so it declines rather
than guess, exactly as designed. Both are almost certainly the owner, split by
diarization across 160 minutes. **Two voices claiming the same self-introduction
is good evidence of an over-split and a candidate for merge** — that is an
identity signal we do not currently use, and it is the obvious next thing here.
In the product the owner is resolved by voiceprint anyway, so this specific miss
is an artifact of seeding offline.

Also note SPEAKER_07 spends the last minutes discussing the band Boris, and
those vocatives are correctly discounted to 0.216 by `organisationTalk`.

### Reviewing ehub-haas

`AMELIA_STORAGE=local npx tsx tools/seed-from-recording.mts ehub-haas`, then
`AMELIA_STORAGE=local npm run dev --workspace=@amelia/server` and open
`/review?conversation=ehub-haas`. 1013 lines, audio resolves, clicking a line
plays that span. The seed script now applies `dropSilentRepeats` too — without
it the review queue would ask about six "Thank you." over applause.

## A sixth copy of the join, and the warning that caught it (2026-08-25)

Adding `dropSilentRepeats` to `session.ts` and to `seed-from-recording.mts` but
not to `server/review/freshness.ts` made the review page report a correctly
seeded store as stale: pipeline 1015 lines, store 1013, the two applause runs.
The banner was right and the store was right; the check was comparing against a
pipeline that no longer existed.

`readRealRecording` in `fixtures/real-audio.ts` already existed for exactly this,
and its own docstring says why — "five suites used to hand-roll this join and
every copy drifted". I added a sixth. The drop now lives inside that reader, and
`freshness.ts`, `seed-from-recording.mts`, `write-transcript.mts` and
`name-evidence.mts` all call it instead of composing the steps themselves.
Freshness reports `current` again, 1013 = 1013.

Two things worth keeping:

- **The step went in front of the join, not inside it.** Anything that inserts a
  stage between the fixtures and `joinTranscriptToTurns` has to go in the reader,
  or the freshness check silently measures the old pipeline. That is the failure
  mode, not the line count.
- The drop uses the RAW `<stem>.pyannote.json` as its speech map even when the
  corrected turns are what gets joined. The corrected turns are a rewrite of the
  diarization, and asking whether a rewrite covers a span is not the same
  question as asking whether anybody spoke there.

The sweep and probe scripts in `eval/real/` still call `joinWordsToSpeakers`
directly and should keep doing so — they vary `minTurnMs`, `snapMs` and the
candidate diarization on purpose. They are measuring a question, not reporting
what the product produces.

### Heads up, 2026-09-05 (streams 6 and 7, wave 2)

- `server/index.ts` gains two registration lines: `registerFaceRoutes(app, deps)` after the identity routes, and `registerPresence(bus)` beside `registerNameSuggestions`. Face observations never touch the bus; only the debounced `presence` event does.
- The sidecar takes three new deps (`insightface`, `onnxruntime`, `opencv-python-headless`) and downloads buffalo_l into `sidecar/.cache/insightface` on first start. Re-run the install from `sidecar/requirements.txt`; `FACE_MODELS=off` skips the model entirely and keeps every voice endpoint working.
- `app/src/state/store.tsx` and `app/src/lib/events.ts`: the store gains `glasses` and `presence` slices (`glasses`, `sweep-presence` actions, a 5 s presence sweep that runs only while somebody is in the room, `setApiBaseOverride` persisting the tailnet base), and `EVENT_NAMES` moved out of `events.ts` into the RN-free `app/src/lib/event-names.ts` — it was missing `name_suggestion`, so that flow never fired against a live server, and it now also carries `presence` and `identity_conflict` with a test asserting it covers `AmeliaEvent` exhaustively.
- `server/audio/session.ts` now takes `faces`, `captureMode`, and `ownerPersonId`; `server/audio/index.ts` passes them from the `/stream` handshake and the face service. `AttributionResult.matched.voiceprint_id` is optional now (a face-only match has no print).
- `firmware/xiao-glasses/` is the new board firmware (ESP-IDF 5.3.2); the first flash over the old UVC build needs manual download mode, see its README. Nothing is flashed yet.
