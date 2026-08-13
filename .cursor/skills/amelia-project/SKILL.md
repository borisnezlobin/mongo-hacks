---
name: amelia-project
description: Guides development of the Amelia hackathon app — lane ownership, shared contracts, gate checklist, and MongoDB Persistent Context Sprint judging criteria. Use when onboarding teammates, resolving cross-lane conflicts, or planning integration work.
---

# Amelia — project guide

## What we are building

Phone app that diarizes live conversation, attributes utterances by voiceprint in Atlas, builds append-only per-person memory (attribute-keyed fact supersession), and hosts a voice-summoned, voiceprint-authorized agent named Amelia.

## Read first

`shared/contracts.ts` — frozen cross-lane types, constants, REST signatures, SSE events. Changes announced aloud; owner: Lane B human.

## Directory ownership (never write outside your tree)

| Path | Lane |
|---|---|
| `/shared/contracts.ts` | Lane 0 once, then B |
| `/fixtures/` | Lane 0 |
| `/server/index.ts`, `/server/lib/bus.ts` | Lane 0 — frozen after T+15 |
| `/server/audio/`, `/server/identity/`, `/sidecar/`, `/app/audio/` | Lane A |
| `/server/memory/`, `/server/ask/`, `/db/` | Lane B |
| `/server/amelia/`, `/video/` | Lane D |
| `/server/glasses/` | Lane E (after T+150) |
| `/app/` (except `/app/audio/`) | Lane C |

## Gates (210 min clock)

| Time | Gate |
|---|---|
| T+15 (1:45) | Contracts + scaffold pushed; lanes start |
| T+50 (2:20) | `/debug/utterance` replay → Mongo + SSE → app utterances |
| T+100 (3:10) | WAV through audio spine + live mic; Lane D → video |
| T+150 (4:00) | Golden path once; Lane E may start |
| T-60 (4:45) | Video final cut |

## Judging weights (Round 1)

- Creativity 35%
- Demo 30%
- Impact 20%
- Technologies Used 25% — MongoDB + partner tools must be **core**, not decorative

## Anti-projects (disqualification risk)

Basic RAG chatbot, Streamlit dashboard-as-main-feature, generic mental health / nutrition coach.

## Agent skills in this repo

See `SKILLS.txt` — MongoDB official skills + partner skills in `.cursor/skills/`.

## Git

One branch per lane (`lane-a` … `lane-e`); merge at gates only; no rebases.
