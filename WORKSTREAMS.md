# Workstreams

Six streams, five people. Nobody owns a directory — anyone can edit anything.
A driver is just the person thinking about a stream end to end, so two people
don't independently redesign the same feature.

Put your name next to a stream and mirror it in your `.team/<you>.md`.

| # | Stream | Driver | Mostly lives in |
|---|---|---|---|
| 1 | Authentication & users | | `server/auth/`, `server/memory/store.ts`, `app/src/screens/auth.tsx` |
| 2 | Better lookup | | `server/ask/`, `server/memory/passes.ts` |
| 3 | Amelia voice + profile tools | | `server/amelia/tts.ts`, `server/amelia/tools.ts` |
| 4 | Loops rework | | `server/loops/`, `app/src/screens/loops.tsx`, `app/src/lib/notifications.ts` |
| 5 | UI | | `app/src/components/`, `app/src/constants/theme.ts` |

Notes below are context, not instructions — things worth knowing before you
start, mostly about where streams touch each other. Build it how you want.

---

## 1. Authentication & users

Everything is currently scoped to a hardcoded `OWNER_ID` from
`shared/contracts.ts`, and `server/ask/retrieval.ts` filters every query by it.
Making that per-user touches most queries in `server/memory/store.ts`, so the
sooner that change is on `main`, the less everyone else rebases through it.

Worth deciding out loud: voiceprint enrollment already identifies the owner by
voice for Amelia authorization, at a different threshold than attribution.
Whether account auth and voice auth are one system or two affects stream 3.

## 2. Better lookup

**On "can we just throw the transcripts into context?" — yes, and the evidence
supports you.** The embedding retrieval has been visibly bad at demo scale, which
is a real signal: at this corpus size vector search is mostly adding noise and
latency, and tuning it is probably not the fix.

Two things about the current code that explain a lot of the badness. Retrieval
in `server/ask/retrieval.ts` returns **10 results**, and it searches over
*extracted facts* rather than transcripts — so the model answers from ten terse
claims stripped of context. Nuance is lost before the LLM ever sees it.

So the instinct is right. Things to know as you go:

- Raw utterances are already in Atlas, so full-context is mostly a query change.
- The cost is latency, and it lands on a spoken reply through ElevenLabs, where
  it's felt more than in a chat box. Worth measuring early.
- The fact pipeline in `server/memory/passes.ts` with its supersession already
  gives you current-state-per-person — that's the fact sheet you described, if
  you want a middle layer later.
- `bun run eval:attribution` exists if you want to compare approaches.

## 3. Amelia voice + profile tools

Grouped because they share the agent's tool loop. "Better voice" could mean
latency, interruption, streaming, or quality — worth saying which you mean.

Profile updates ("I'm Tarun and I'm 40, born July 15th") means tools like
`set_name` / `set_birthday` in `server/amelia/tools.ts`. One thing that'll bite:
these are writes arriving over a voice channel, so they inherit the owner
authorization threshold, not the attribution one. There's also an existing
append-only fact path with supersession — using it keeps a corrected birthday's
history like every other fact, rather than adding a second way to write.

## 4. Loops rework

The one place with a hidden dependency: `app/src/lib/notifications.ts` is
local-only, so anything that has to fire while the app is closed needs a push
token, a server-side scheduler, and a delivery path that doesn't exist yet.
That's the difference between an afternoon and two days, so it's worth knowing
on day one.

Since "clearer" is part of the goal, whatever you land on for what a Loop *is*
is useful to the other four — a line in your `.team` file saves someone else
guessing from the UI.

## 5. UI

The shared primitives in `app/src/components/ui.tsx` and
`app/src/constants/theme.ts` are the thing others build on, so they're more
useful early than late.

Existing constraints from `CLAUDE.md`: light mode only, Manrope and Newsreader,
Phosphor icons, sentence-case copy, no emoji.

---

## Backlog

Unclaimed and undriven. Written down so the next person picking something up
starts from context rather than from scratch.

### Contact sync

A person in Amelia today is a voiceprint plus a name somebody typed into the
naming sheet — `Person` in `shared/contracts.ts` carries `_id`, `owner_id`,
`name`, an optional `relationship`, and timestamps, and nothing else. So the
system can recognise a voice across weeks of conversation and still not be able
to put a phone number to it. That gap is the whole reason this belongs in
Amelia specifically: the product's claim is a memory of the people in the room,
and the address book is where the rest of what you know about those people
already lives.

Contact sync means reconciling Amelia's people against the phone's address
book, in both directions. When someone types "Maya" into the naming sheet,
offer the matching contact rather than making them retype what the phone
already knows. When there's no match, offer to create a contact for the voice
that just got a name.

Where it touches existing code:

- `shared/contracts.ts` — `Person` needs somewhere to hold the link. A contact
  identifier rather than a copy of the contact is the cheaper shape, and it
  keeps the address book authoritative. This is a shared-contract change, so it
  wants to land as its own commit first.
- `app/src/components/naming-sheet.tsx` — the natural place for a match to
  surface, since it already takes a name and a relationship and is the one
  moment a human is deliberately telling Amelia who this is. It currently calls
  `onSave(name, relationship, isOwner?)`; a contact suggestion is another thing
  that flows through that same confirmation.
- `mergePeople` (`server/memory/store.ts:318`, exposed via
  `POST /people/merge` and `app/src/lib/api.ts`) — two Amelia people resolving
  to the same contact is evidence they are the same person, which is exactly
  the judgement merge already exists to carry out. Contact sync should produce
  merge candidates for a human to confirm, not merge on its own.

The hazard is the point, not a footnote. The address book is personal data
about people who never opted into Amelia and cannot be asked. It should be read
on demand, on the device, for the duration of a match, and not uploaded,
mirrored into Atlas, or embedded. Nothing about a contact should leave the
phone without the owner explicitly choosing to send that specific thing. A
stored contact identifier is a pointer the phone can resolve; a stored phone
number is somebody else's data sitting on our server.

Note that `expo-contacts` is not currently a dependency in `app/package.json`,
so this starts with adding it and with the OS permission prompt that comes with
it — worth knowing before scoping it as an afternoon.
