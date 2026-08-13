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

app = FastAPI(title="amelia-voiceprint")

_model = None


def get_model():
    global _model
    if _model is None:
        _model = EncoderClassifier.from_hparams(
            source="speechbrain/spkrec-ecapa-voxceleb",
            savedir=os.path.join(os.path.dirname(__file__), "pretrained/ecapa"),
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
    vec = vec / vec.norm(p=2)  # L2-normalised so cosine == dot product
    return vec.tolist()


@app.get("/health")
def health():
    get_model()
    return {"ok": True, "dims": EMBED_DIMS, "sample_rate": SAMPLE_RATE}


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
