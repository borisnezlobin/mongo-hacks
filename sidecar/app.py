"""Speaker sidecar: ECAPA voiceprints, pyannote diarization, and face embeddings.

Three jobs, deliberately in one process because they share a CPU budget and
because the server already knows how to reach exactly one of these.

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

Image contract: a raw JPEG body. /face/embed is handed a crop the phone already
cut around one face and answers with a 512-dim vector; /face/detect is handed a
whole frame and is only for the laptop harness, which has no Vision framework
to do its own detection.

Throughput: one ECAPA forward pass on CPU costs roughly 15-30 ms per second of
audio, so a single worker keeps up with realtime by a wide margin for the
clustering traffic (one short embed per turn) and comfortably for pooled
attribution embeds. It does NOT parallelise: requests are handed to a thread
pool and torch is told how many threads it may use, but the model is one shared
instance and long pooled embeds queue behind each other. That is the reason the
server side batches attribution onto a ladder instead of re-embedding per frame.
"""

import base64
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

# Mirrors FACEPRINT_DIMS, FACE_CROP_MAX_PX and FACE_THUMBNAIL_PX in the shared
# contracts. The server asserts the dimension it gets back, so a model swap
# that changes it fails loudly on the first crop rather than writing 512 zeros.
FACE_DIMS = 512
FACE_MODEL = "buffalo_l"
FACE_DET_SIZE = (320, 320)
FACE_CROP_MAX_PX = 224

_model = None
_diarizer = None
_diarizer_error: str | None = None
_face_app = None
_face_error: str | None = None


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
    warm_face_app()
    if _face_app is None:
        print(f"face embedding unavailable: {_face_error}")
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
        "face": _face_app is not None,
        "face_dims": FACE_DIMS,
        "face_model": FACE_MODEL,
        **({"face_error": _face_error} if _face_error else {}),
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


def _face_cache_dir() -> str:
    return os.environ.get(
        "INSIGHTFACE_CACHE_DIR",
        os.path.join(os.path.dirname(__file__), ".cache/insightface"),
    )


def _face_threads() -> int:
    return max(1, int(os.environ.get("FACE_ORT_THREADS", "2")))


def get_face_app():
    """InsightFace buffalo_l on CPU, or None with the reason recorded.

    Loaded lazily and warmed at startup, exactly like the diarizer, and for the
    same reason: the first crop of a session is the one that decides how fast a
    face gets a name, and graph construction plus a cold model download is tens
    of seconds. It also fails the same way — a missing wheel, a failed Cython
    build or FACE_MODELS=off records the reason and leaves every voice endpoint
    untouched, because voice identity is what the product does without a camera.

    Threads are capped rather than left to onnxruntime's default of one per
    core. This process is already sharing its CPU with a torch runtime told it
    may have four, and a detector that grabs every remaining core makes the
    embeds it is supposed to be helping slower.
    """
    global _face_app, _face_error
    if _face_app is not None or _face_error is not None:
        return _face_app
    if os.environ.get("FACE_MODELS", "").strip().lower() in {"off", "0", "false", "no"}:
        _face_error = "FACE_MODELS=off"
        return None
    threads = _face_threads()
    os.environ.setdefault("OMP_NUM_THREADS", str(threads))
    try:
        import onnxruntime
        from insightface.app import FaceAnalysis

        options = onnxruntime.SessionOptions()
        options.intra_op_num_threads = threads
        options.inter_op_num_threads = 1
        analysis = FaceAnalysis(
            name=FACE_MODEL,
            root=_face_cache_dir(),
            allowed_modules=["detection", "recognition", "landmark_2d_106"],
            providers=["CPUExecutionProvider"],
            sess_options=options,
        )
        analysis.prepare(ctx_id=-1, det_size=FACE_DET_SIZE)
        _face_app = analysis
    except Exception as error:  # noqa: BLE001 - reported to the caller verbatim
        _face_error = f"could not load insightface {FACE_MODEL}: {error}"
        return None
    return _face_app


def warm_face_app() -> None:
    """Build the graphs on a blank frame so the first real crop is not the first run."""
    analysis = get_face_app()
    if analysis is None:
        return
    analysis.get(np.zeros((FACE_DET_SIZE[1], FACE_DET_SIZE[0], 3), dtype=np.uint8))


def require_face_app():
    analysis = get_face_app()
    if analysis is None:
        raise HTTPException(503, _face_error or "face embedding is not available")
    return analysis


def decode_jpeg(raw: bytes):
    """JPEG bytes -> BGR array, the layout every insightface model expects."""
    import cv2

    if not raw:
        raise HTTPException(400, "empty image")
    image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise HTTPException(400, "body is not a decodable JPEG")
    return image


def face_area(face) -> float:
    left, top, right, bottom = [float(value) for value in face.bbox]
    return max(0.0, right - left) * max(0.0, bottom - top)


def bbox_of(face) -> dict:
    left, top, right, bottom = [float(value) for value in face.bbox]
    return {"x": left, "y": top, "width": right - left, "height": bottom - top}


def unit_vector(face) -> list[float]:
    """L2-normalised so the server's cosine is a plain dot product, as with voices."""
    vector = np.asarray(face.embedding, dtype=np.float32)
    magnitude = float(np.linalg.norm(vector))
    if magnitude == 0:
        raise HTTPException(422, "face embedding is degenerate")
    return (vector / magnitude).tolist()


def embed_largest_face(image) -> dict:
    faces = require_face_app().get(image)
    if not faces:
        raise HTTPException(422, "no face in this crop")
    face = max(faces, key=face_area)
    return {
        "vector": unit_vector(face),
        "dims": FACE_DIMS,
        "det_score": float(face.det_score),
        "bbox": bbox_of(face),
    }


def padded_crop(image, face, max_px: int) -> str:
    """The face plus a margin, downscaled, as base64 JPEG.

    The margin is 25% of the box on every side. A tight crop of the box alone
    is a worse thumbnail and a worse re-embed: the detector's box stops at the
    jaw, and hair and ears are most of what a person recognises a face by.
    """
    import cv2

    height, width = image.shape[:2]
    left, top, right, bottom = [float(value) for value in face.bbox]
    margin_x = (right - left) * 0.25
    margin_y = (bottom - top) * 0.25
    x0 = max(0, int(left - margin_x))
    y0 = max(0, int(top - margin_y))
    x1 = min(width, int(right + margin_x))
    y1 = min(height, int(bottom + margin_y))
    crop = image[y0:y1, x0:x1]
    if crop.size == 0:
        return ""
    longest = max(crop.shape[0], crop.shape[1])
    if longest > max_px:
        scale = max_px / longest
        crop = cv2.resize(crop, (max(1, int(crop.shape[1] * scale)), max(1, int(crop.shape[0] * scale))))
    ok, encoded = cv2.imencode(".jpg", crop, [int(cv2.IMWRITE_JPEG_QUALITY), 88])
    return base64.b64encode(encoded.tobytes()).decode("ascii") if ok else ""


def points_of(values) -> list[list[float]]:
    if values is None:
        return []
    return [[float(x), float(y)] for x, y in np.asarray(values, dtype=np.float32)]


def detect_faces(image) -> list[dict]:
    faces = require_face_app().get(image)
    return [
        {
            "bbox": bbox_of(face),
            "det_score": float(face.det_score),
            "kps": points_of(getattr(face, "kps", None)),
            "landmark_2d_106": points_of(getattr(face, "landmark_2d_106", None)),
            "crop_jpeg_base64": padded_crop(image, face, FACE_CROP_MAX_PX),
        }
        for face in sorted(faces, key=face_area, reverse=True)
    ]


@app.post("/face/embed")
async def embed_face(request: Request):
    """A JPEG crop of one face -> a 512-dim L2-normalised faceprint.

    The phone has already detected and cut the face, so more than one face in
    the body means the crop was loose; the largest wins, because that is the
    one the crop was cut around. No face at all is a 422 rather than an empty
    answer — the caller has a track waiting on a decision and needs to know the
    difference between "not this person" and "not a face".
    """
    raw = await request.body()
    image = decode_jpeg(raw)
    started = time.time()
    result = await run_in_threadpool(embed_largest_face, image)
    return {**result, "elapsed_ms": int((time.time() - started) * 1000)}


@app.post("/face/detect")
async def detect_frame(request: Request):
    """A whole JPEG frame -> every face in it, with landmarks and a padded crop.

    For the laptop harness only. On the phone this work is done by Apple Vision
    locally, because shipping whole frames to a server over cellular is the one
    thing the crop-only uplink exists to avoid.
    """
    raw = await request.body()
    image = decode_jpeg(raw)
    started = time.time()
    faces = await run_in_threadpool(detect_faces, image)
    return {
        "faces": faces,
        "width": int(image.shape[1]),
        "height": int(image.shape[0]),
        "elapsed_ms": int((time.time() - started) * 1000),
    }
