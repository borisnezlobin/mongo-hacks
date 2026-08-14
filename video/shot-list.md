# Amelia demo video — shot list and narration

90 seconds, one continuous room. Phone on the table the whole time. No cuts to
slides — the product is the point.

The demo data is the fixture: Yan (owner), Maya, Jules, Priya. Maya's move to
Oakland is the thread. The canonical command is the closer.

## Beats

**0–8s — cold open, the problem.**
Four people talking over each other. Voiceover: "Your phone records everything.
It remembers nothing about who said it." Cut to a raw transcript — no names, no
memory.

**8–20s — separate the speakers.**
Phone on the table, tap "Start listening." The conversation screen fills in live,
four speakers in four colors as they talk. Point at the screen: "Amelia separates
the room as it happens — every word is already tied to a voice."

**20–32s — the moment a fact changes (the money shot).**
Maya: "Actually, my move got pushed — it's September 15th now, not the first."
Amelia chimes out loud: "That changed: Maya moves to Oakland on September 15th."
On screen, the fact card updates and the old date is struck through, not erased.
Voiceover: "It doesn't overwrite. It supersedes — the old value is kept, the new
one is current."

**32–48s — name a stranger, history attaches.**
An unknown voice has been talking. Tap "Name this voice," type "Priya." Every
line she already said re-files under her name instantly, avatar stays the same.
Voiceover: "A voice you just met already has a history. Name it once and it all
files itself."

**48–70s — the canonical command.**
Hold the pill (or say "Hey Amelia"), then:
"Email Maya asking how the move is going — if she's already moved, ask how
Oakland is treating her. If she hasn't, ask whether she needs help packing."
Watch the live step trace: search → resolve the current move date → branch →
draft. Amelia answers out loud: the draft asks about packing, because September
15th hasn't passed. Voiceover: "It checks the current fact before it acts, picks
the right branch, and drafts — never sends — the email."

**70–85s — the open loop.**
Earlier Jules said "I'll send the photos tonight." The Loops tab shows it, due
tonight. A local notification fires. Voiceover: "Promises people make to you
become reminders — on the device, no push server."

**85–90s — close.**
Wordmark. "Amelia remembers not only what was said, but who said it, when it
changed, and what still needs to happen."

## Production notes

- Record on the real phone against the seeded Atlas cluster, not the mock stream —
  the live step trace and supersession are the credibility.
- Stage fallback for every beat: long-press the pill to type the summon; replay
  the fixture with `node fixtures/replay.mjs` if the room is noisy.
- The 20–32s supersession beat depends on the live-context intervention
  (AMELIA_LIVE_CONTEXT on by default). Confirm the cooldown has elapsed before
  the take or the chime is swallowed.
- Known limitation to shoot around: the step trace shows the current value
  ("September 15th"), not the old→new arrow, until MemoryApi.resolveFactState
  exposes the supersession chain (TODO(contracts) in tools.ts). The fact card on
  screen carries the strike-through, so frame the phone for that beat.

## Capture commands

```bash
bun run dev                 # server + bus + memory + amelia
# sidecar already running on :8099 for voiceprints
node fixtures/replay.mjs    # paced fixture replay if the room won't cooperate
```
