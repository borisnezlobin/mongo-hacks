---
name: pyannote-diarization
description: Integrates pyannote.audio for live speaker diarization in Amelia Lane A. Use when wiring Realtime diarization, PYANNOTE_API_KEY, utterance segmentation, or the audio WebSocket spine.
---

# pyannote — live diarization (Lane A)

## Env

- `PYANNOTE_API_KEY` — pyannote.ai or HuggingFace-gated model access
- Audio frames: float32 PCM, 16 kHz mono, 100 ms (1600 samples) per `shared/contracts.ts`

## Architecture (Lane A owns)

```
Phone mic → WS /stream → pyannote Realtime → utterance segments
                              ↓
                    ECAPA sidecar (/sidecar/) → voiceprint match → person_id
                              ↓
                         bus.emit(utterance) + MongoDB persist (Lane B)
```

## WebSocket framing

1. First frame: JSON text `{ "conversation_id": "..." }`
2. Subsequent: binary float32 PCM, 6400 bytes per frame

## Diarization → identity

- Unknown speakers: emit utterance with `person_id` unset, `voiceprint_id` from cluster
- Named speaker: `POST /people/:id/name` attaches history via identity events
- Merge duplicates: `POST /people/merge` — re-point utterances/facts/promises, never delete voiceprints

## Fixture gate (T+50 vs T+100)

- **T+50**: `/debug/utterance` replay from `fixtures/replay.mjs` — no pyannote required
- **T+100**: `fixtures/conversation.wav` through full audio spine + live mic

## Thresholds (contracts.ts)

- `ATTRIBUTION_THRESHOLD = 0.75` — tune at venue
- `EMBED_MIN_MS = 3000` — minimum segment for embedding/enrollment

## Do not

- Write outside `/server/audio/`, `/server/identity/`, `/sidecar/`, `/app/audio/`
- Block SSE on diarization — emit provisional utterances, revise via same `utterance_id`
