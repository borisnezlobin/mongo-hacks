"""Speaker sidecar: ECAPA voiceprints, and pyannote diarization.

Two jobs, deliberately in one process because they share a torch runtime and a
CPU budget.

/embed turns raw PCM into a 192-dim voiceprint. It answers "who is this",
across sessions, against stored prints. The Node server owns all buffering and
thresholds; this process only turns audio into a vector.

/diarize turns a whole recording into speaker turns. It answers "how many
people are here and when did each of them talk", within one recording, and it
answers it far better than anything built out of /embed can: pooled provider
labels produce blends, and a blend resembles another blend more than a person
resembles himself (two different men scored 0.850 while one man against himself
scored 0.833). Swapping encoders does not fix that — ECAPA, SpeechBrain ResNet,
x-vector and WeSpeaker ResNet34-LM were compared and the best same-vs-different
gap was 0.079 against ECAPA's 0.072. pyannote's own segmentation model is what
fixes it.

Audio contract (matches the WS uplink framing): float32 little-endian,
16 kHz, mono, samples in -1..1.

Throughput: one ECAPA forward pass on CPU costs roughly 15-30 ms per second of
audio, so a single worker keeps up with realtime by a wide margin for the
clustering traffic (one short embed per turn) and comfortably for pooled
attribution embeds. It does NOT parallelise: requests are handed to a thread
pool and torch is told how many threads it may use, but the model is one shared
instance and long pooled embeds queue behind each other. That is the reason the
server side batches attribution onto a ladder instead of re-embedding per frame.
"""

import os
import time
from contextlib import asynccontextmanager

import numpy as np
import torch
from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from speechbrain.inference.speaker import EncoderClassifier

SAMPLE_RATE = 16_000
EMBED_DIMS = 192
DIARIZE_MODEL = "pyannote/speaker-diarization-3.1"
# Mirrors EMBED_MIN_MS in the shared contracts. Below this the embedding is
# not stable enough to attribute a turn, so we refuse rather than guess.
EMBED_MIN_MS = 3000

_model = None
_diarizer = None
_diarizer_error: str | None = None


def get_model():
    global _model
    if _model is None:
        _model = EncoderClassifier.from_hparams(
            source="speechbrain/spkrec-ecapa-voxceleb",
            # SpeechBrain downloads into this repository-local ignored cache.
            # Generated links must not point into one developer's global cache.
            savedir=os.environ.get(
                "ECAPA_CACHE_DIR",
                os.path.join(os.path.dirname(__file__), ".cache/ecapa"),
            ),
            run_opts={"device": "cpu"},
        )
    return _model


def get_diarizer():
    """The pyannote pipeline, or None with the reason recorded.

    Its weights are gated on Hugging Face, so a sidecar without HF_TOKEN — or
    one whose account has not accepted the model terms — cannot load it. That
    must not take /embed down with it: identity is what makes a name appear at
    all, and it works without any of this.
    """
    global _diarizer, _diarizer_error
    if _diarizer is not None or _diarizer_error is not None:
        return _diarizer
    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_TOKEN")
    if not token:
        _diarizer_error = "HF_TOKEN is not set, and pyannote's weights are gated"
        return None
    try:
        from pyannote.audio import Pipeline

        _diarizer = Pipeline.from_pretrained(DIARIZE_MODEL, token=token)
    except Exception as error:  # noqa: BLE001 - reported to the caller verbatim
        _diarizer_error = f"could not load {DIARIZE_MODEL}: {error}"
        return None
    return _diarizer


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Load and exercise both models before the port opens.

    Lazy loading put several seconds of model download, disk read and graph
    construction in front of the first embed of a session — which is the one
    embed that decides how fast the first speaker gets a name. The diarizer is
    much larger again and its first request is a whole recording, so a cold
    load there lands on a user who is already waiting on a slow pass. Warming
    both here moves the cost to a startup the operator is waiting through
    anyway.
    """
    torch.set_num_threads(int(os.environ.get("ECAPA_TORCH_THREADS", "4")))
    model = get_model()
    with torch.no_grad():
        model.encode_batch(torch.zeros(1, SAMPLE_RATE))
    diarizer = get_diarizer()
    if diarizer is None:
        print(f"diarization unavailable: {_diarizer_error}")
    else:
        # Two seconds of noise rather than silence, so the warmup runs the
        # embedding and clustering stages as well as segmentation. What it is
        # buying is the model download, the disk read and the graph
        # construction, which is tens of seconds on a cold cache and would
        # otherwise land on the first user to stop a recording.
        noise = torch.from_numpy(
            np.random.default_rng(0).normal(0, 0.01, 2 * SAMPLE_RATE).astype("float32")
        ).unsqueeze(0)
        diarizer({"waveform": noise, "sample_rate": SAMPLE_RATE})
    yield


app = FastAPI(title="amelia-speaker-sidecar", lifespan=lifespan)


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


def _response(audio: torch.Tensor, vector: list[float]) -> dict:
    return {
        "vector": vector,
        "dims": len(vector),
        "duration_ms": int(audio.shape[-1] / SAMPLE_RATE * 1000),
    }


@app.get("/health")
def health():
    return {
        "ok": _model is not None,
        "dims": EMBED_DIMS,
        "sample_rate": SAMPLE_RATE,
        "diarization": _diarizer is not None,
        "diarization_model": DIARIZE_MODEL,
        **({"diarization_error": _diarizer_error} if _diarizer_error else {}),
    }


def diarize(audio: torch.Tensor) -> list[dict]:
    """Speaker turns over a whole recording, overlaps included.

    The waveform is handed over in memory rather than as a path. pyannote 4
    reads files through torchcodec, whose native library does not link against
    the ffmpeg on this machine, and a diarizer that only works on some laptops
    is not a diarizer.
    """
    pipeline = get_diarizer()
    annotation = pipeline({"waveform": audio, "sample_rate": SAMPLE_RATE})
    turns = [
        {
            "start_ms": int(round(float(turn["start"]) * 1000)),
            "end_ms": int(round(float(turn["end"]) * 1000)),
            "speaker": str(turn["speaker"]),
        }
        for turn in annotation.serialize()["diarization"]
    ]
    turns.sort(key=lambda turn: (turn["start_ms"], turn["end_ms"]))
    return turns


def simultaneous_ms(turns: list[dict]) -> int:
    """Time two or more different speakers hold at once.

    Reported rather than resolved. Overlapping turns are a real output of this
    model and the reason it is here — the chunked provider labels it replaces
    could not express simultaneous speech at all, so a sentence spoken over
    another sentence had to be given to exactly one of the two people, and half
    of those assignments were wrong by construction.
    """
    total = 0
    for index, first in enumerate(turns):
        for second in turns[index + 1 :]:
            if second["start_ms"] >= first["end_ms"]:
                break
            if second["speaker"] != first["speaker"]:
                total += max(
                    0,
                    min(first["end_ms"], second["end_ms"]) - max(first["start_ms"], second["start_ms"]),
                )
    return total


@app.post("/diarize")
async def diarize_pcm(request: Request):
    """Raw float32 PCM body -> speaker turns, which may overlap in time.

    The body is a whole recording, so it is large: 16 kHz float32 is 64 kB per
    second, and the owner's 48-minute conversation is 184 MB. That is the price
    of one contract for all audio in this process rather than a second framing
    for long files.
    """
    if get_diarizer() is None:
        raise HTTPException(503, _diarizer_error or "diarization is not available")
    raw = await request.body()
    audio = pcm_to_tensor(raw)
    duration_ms = int(audio.shape[-1] / SAMPLE_RATE * 1000)

    started = time.time()
    turns = await run_in_threadpool(diarize, audio)
    elapsed_ms = int((time.time() - started) * 1000)
    return {
        "turns": turns,
        "speakers": sorted({turn["speaker"] for turn in turns}),
        "overlap_ms": simultaneous_ms(turns),
        "duration_ms": duration_ms,
        "elapsed_ms": elapsed_ms,
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

    # The forward pass is blocking and holds the event loop otherwise, which
    # stalls every other in-flight embed behind whichever one is longest.
    vector = await run_in_threadpool(embed, audio)
    return _response(audio, vector)


@app.post("/embed/short")
async def embed_pcm_short(request: Request):
    """Same as /embed with no duration floor. For clustering, not identity.

    This used to be called /embed/unsafe and warned "never call this on a live
    conversation turn", while the live clustering path called it for every turn.
    The call was right and the warning was wrong: a sub-second embedding cannot
    name a person, but it answers the far easier question the clusterer asks —
    is this the same voice as a moment ago, on the same microphone, in the same
    room. What must never happen is one of these reaching identity, and that is
    a property of the caller, so the endpoint says what it is for instead of
    forbidding its only real use.
    """
    raw = await request.body()
    audio = pcm_to_tensor(raw)
    vector = await run_in_threadpool(embed, audio)
    return _response(audio, vector)


@app.post("/embed/unsafe")
async def embed_pcm_unsafe(request: Request):
    """Former name of /embed/short. Kept so an older server keeps working."""
    return await embed_pcm_short(request)
