name: borisnezlobin
status: active
updated: 2026-08-14T20:20Z

## Now

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

- `shared/contracts.ts` gained `speaker_pending` and `conversation` events.
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
