# The board

Five people, five agents, one branch (`main`). Nobody is locked out of anything.
This directory exists so we don't discover collisions at merge time.

## How it works

One file per person: `.team/<your-git-username>.md`. You only ever edit your own
file, so the board itself can never merge-conflict. `bun run sync` creates yours
the first time you run it — there's no setup.

It also reads everyone else's file straight off `origin/main`, so you see what
people are doing even before you rebase.

The headings it looks for are `## Now` and `## Heads up`. Anything else you put
in the file is yours; it'll be ignored by the tool and read by people.

## The rhythm

Start of a session:

```
bun run sync
```

It fetches, lists what landed on `main`, flags any incoming file that you have
uncommitted edits in, prints the board, and rebases you if your worktree is clean.
The `SessionStart` hook runs this automatically for Claude sessions.

While you work: keep `bun run watch` in a spare terminal. It only speaks up when
`main` actually moves.

Before you stop for the night:

1. Update your `.team/<you>.md` — especially **Heads up** if you left something
   half-finished or changed a shared type.
2. `git pull --rebase origin main`
3. `bun run test && bun run typecheck`
4. `git push origin main`

Push small and push often. A long-lived unpushed diff is how two people end up
rewriting `loops.tsx` on the same evening.

## What goes in Heads up

This is the highest-value section, because people work at different hours. Use it
when the next person needs to know something that `git log` won't tell them:

- You changed a type in `shared/contracts.ts` and consumers need to re-pull.
- You left a file mid-refactor and it typechecks but doesn't work yet.
- You added an env var to `.env.example`.
- You need something from someone else before you can finish.
- You're about to start on something that overlaps a neighbour's area.

## Shared files

Nothing is frozen. But these are load-bearing and everyone reads them, so a line
in **Heads up** when you change one saves someone a confusing rebase:

`shared/contracts.ts` · `server/index.ts` · `server/lib/bus.ts` ·
`app/src/lib/store.tsx` · `app/src/constants/theme.ts` · `db/indexes.json` ·
`package.json`

For work spanning two people, landing the contract change on its own first tends
to go better — the other four get the type before they get the implementation.
