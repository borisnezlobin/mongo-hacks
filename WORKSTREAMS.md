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
