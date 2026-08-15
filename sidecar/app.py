"""ECAPA-TDNN speaker embedding sidecar.

Takes raw PCM and returns a 192-dim voiceprint. The Node server owns all
buffering and thresholds; this process only turns audio into a vector.

Audio contract (matches the WS uplink framing): float32 little-endian,
16 kHz, mono, samples in -1..1.
"""

import os

import numpy as np
import torch
from fastapi import FastAPI, HTTPException, Request
from speechbrain.inference.speaker import EncoderClassifier

SAMPLE_RATE = 16_000
EMBED_DIMS = 192
# Mirrors EMBED_MIN_MS in the shared contracts. Below this the embedding is
# not stable enough to attribute a turn, so we refuse rather than guess.
EMBED_MIN_MS = 3000

MODEL_SOURCE = "speechbrain/spkrec-ecapa-voxceleb"
# Pinned to a specific commit, not to `main`.
#
# Stored voiceprints and freshly computed ones are only comparable if they came
# out of the same weights. An upstream push to the model repo, or a reinstall
# that happens to fetch a newer snapshot, moves the embedding space underneath
# a database of vectors that cannot be recomputed — and it does so with no
# error, no exception, and no log line. The only symptom is attribution slowly
# getting worse, which is indistinguishable from a bad room.
#
# 0f99f2d is the repo state as of 2025-02-18. Changing it invalidates every
# voiceprint in Atlas; they must be re-enrolled, not migrated.
MODEL_REVISION = os.environ.get(
    "ECAPA_REVISION", "0f99f2d0ebe89ac095bcc5903c4dd8f72b367286"
)

app = FastAPI(title="amelia-voiceprint")

_model = None


def get_model():
    global _model
    if _model is None:
        _model = EncoderClassifier.from_hparams(
            source=MODEL_SOURCE,
            revision=MODEL_REVISION,
            # SpeechBrain downloads into this repository-local ignored cache.
            # Generated links must not point into one developer's global cache.
            savedir=os.environ.get(
                "ECAPA_CACHE_DIR",
                os.path.join(os.path.dirname(__file__), ".cache/ecapa"),
            ),
            run_opts={"device": "cpu"},
        )
    return _model


def pcm_to_tensor(raw: bytes) -> torch.Tensor:
    if len(raw) % 4 != 0:
        raise HTTPException(400, f"float32 PCM must be a multiple of 4 bytes, got {len(raw)}")
    audio = np.frombuffer(raw, dtype="<f4").astype(np.float32)
    if audio.size == 0:
        raise HTTPException(400, "empty audio")
    return torch.from_numpy(audio.copy()).unsqueeze(0)


def embed(audio: torch.Tensor) -> list[float]:
    with torch.no_grad():
        vec = get_model().encode_batch(audio).squeeze()

    # Refuse rather than divide by zero.
    #
    # This is reachable, not theoretical: the eval fixture pads turns with exact
    # digital silence, and a muted mic produces the same thing. An all-zero
    # embedding has norm 0, and `vec / 0` yields NaNs — which then travel into
    # Atlas as a stored voiceprint, compare as NaN against everything, and make
    # every cosine involving that row silently false. A 422 here costs one
    # skipped turn; a NaN voiceprint quietly degrades attribution for good.
    norm = vec.norm(p=2)
    if not torch.isfinite(norm) or norm.item() == 0.0:
        raise HTTPException(422, "audio produced a degenerate embedding (silence or no speech)")

    vec = vec / norm  # L2-normalised so cosine == dot product
    if not torch.isfinite(vec).all():
        raise HTTPException(422, "embedding contains non-finite values")

    return vec.tolist()


@app.get("/health")
def health():
    get_model()
    # The revision is reported so "why did attribution get worse" can be
    # answered by looking, rather than by guessing which snapshot this process
    # happens to have cached.
    return {
        "ok": True,
        "dims": EMBED_DIMS,
        "sample_rate": SAMPLE_RATE,
        "model": MODEL_SOURCE,
        "revision": MODEL_REVISION,
    }


@app.post("/embed")
async def embed_pcm(request: Request):
    """Raw float32 PCM body -> 192-dim L2-normalised voiceprint."""
    raw = await request.body()
    audio = pcm_to_tensor(raw)
    duration_ms = int(audio.shape[-1] / SAMPLE_RATE * 1000)

    if duration_ms < EMBED_MIN_MS:
        raise HTTPException(
            422,
            f"need >={EMBED_MIN_MS}ms of speech to embed, got {duration_ms}ms",
        )

    vector = embed(audio)
    return {"vector": vector, "dims": len(vector), "duration_ms": duration_ms}


@app.post("/embed/unsafe")
async def embed_pcm_unsafe(request: Request):
    """Same as /embed but skips the duration floor.

    Only for enrollment playback and fixture tests, where the caller already
    knows the clip is clean. Never call this on a live conversation turn.
    """
    raw = await request.body()
    audio = pcm_to_tensor(raw)
    vector = embed(audio)
    return {
        "vector": vector,
        "dims": len(vector),
        "duration_ms": int(audio.shape[-1] / SAMPLE_RATE * 1000),
    }
