"""Embeddings for cross-recording person models, from owner-labelled speech only.

Everything else in eval/real/ measures identity inside one recording. This
builds the two things a cross-recording study needs and nothing else:

  spans   one vector per clean labelled piece of a person's speech
  pools   one vector per random pooling of D seconds of a person's speech

A "clean piece" is a reference span with every overlapping stretch of a
different person's reference span cut out of it, because a fragment spoken over
somebody else describes both of them. Pools are built by concatenating clean
pieces, which is what the product does when it pools a cluster's audio -- silence
and turn boundaries between somebody's own words are not evidence against them.

  python eval/real/person_models.py dorm-9pm dorm-40min

Writes eval/real/<stem>.personemb.npz. Real-people data: gitignored, stays here.
"""

import json
import os
import sys

import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from embedders import load  # noqa: E402

CHECKPOINT = os.environ.get("SPK_MODEL", "pyannote/wespeaker-voxceleb-resnet34-LM")
MIN_PIECE_S = 0.5
SPAN_CAP_S = 20.0
POOL_DURATIONS = [1.0, 2.0, 4.0, 8.0, 12.0, 20.0, 30.0, 45.0]
POOLS_PER_CELL = 40


def clean_pieces(spans: list[dict]) -> list[dict]:
    """Reference spans with other people's overlapping speech removed."""
    out = []
    for index, span in enumerate(spans):
        pieces = [(span["start_ms"], span["end_ms"])]
        for other in spans:
            if other is span or other["speaker"] == span["speaker"]:
                continue
            if other["start_ms"] >= span["end_ms"] or other["end_ms"] <= span["start_ms"]:
                continue
            kept = []
            for lo, hi in pieces:
                if other["end_ms"] <= lo or other["start_ms"] >= hi:
                    kept.append((lo, hi))
                    continue
                if other["start_ms"] > lo:
                    kept.append((lo, other["start_ms"]))
                if other["end_ms"] < hi:
                    kept.append((other["end_ms"], hi))
            pieces = kept
            if not pieces:
                break
        for lo, hi in pieces:
            if hi - lo >= MIN_PIECE_S * 1000:
                out.append({"speaker": span["speaker"].lower(), "span": index, "lo": lo / 1000, "hi": hi / 1000})
    return out


def embed_clips(embed_batch, clips: list[np.ndarray], batch: int = 12) -> np.ndarray:
    order = sorted(range(len(clips)), key=lambda i: len(clips[i]))
    vectors = np.zeros((len(clips), 0))
    for start in range(0, len(order), batch):
        group = order[start : start + batch]
        width = max(len(clips[i]) for i in group)
        block = np.zeros((len(group), width), dtype="float32")
        for row, i in enumerate(group):
            block[row, : len(clips[i])] = clips[i]
        out = np.asarray(embed_batch(block), dtype="float64")
        out = out / np.linalg.norm(out, axis=1, keepdims=True)
        if vectors.shape[1] == 0:
            vectors = np.zeros((len(clips), out.shape[1]))
        for row, i in enumerate(group):
            vectors[i] = out[row]
        print(f"    {min(start + batch, len(order))}/{len(order)}", flush=True)
    return vectors


def main(stem: str) -> None:
    spans = json.load(open(f"eval/real/{stem}.reference.json"))["spans"]
    audio, sr = sf.read(f"fixtures/real/{stem}.wav", dtype="float32")
    pieces = clean_pieces(spans)
    people = sorted({piece["speaker"] for piece in pieces})
    print(f"{stem}: {len(spans)} spans -> {len(pieces)} clean pieces, people {people}", flush=True)

    embed_batch = load(CHECKPOINT)

    span_clips = [audio[int(p["lo"] * sr) : int(min(p["hi"], p["lo"] + SPAN_CAP_S) * sr)] for p in pieces]
    print("  span embeddings", flush=True)
    span_vectors = embed_clips(embed_batch, span_clips)

    rng = np.random.default_rng(0)
    pool_clips, pool_rows = [], []
    for person in people:
        owned = [i for i, p in enumerate(pieces) if p["speaker"] == person]
        available = sum(pieces[i]["hi"] - pieces[i]["lo"] for i in owned)
        for duration in POOL_DURATIONS:
            if available < duration * 1.5:
                continue
            for trial in range(POOLS_PER_CELL):
                order = list(rng.permutation(owned))
                taken, total, members = [], 0.0, []
                for i in order:
                    if total >= duration:
                        break
                    room = duration - total
                    lo = pieces[i]["lo"]
                    take = min(pieces[i]["hi"] - lo, room)
                    taken.append(audio[int(lo * sr) : int((lo + take) * sr)])
                    total += take
                    members.append(i)
                if total < duration * 0.98:
                    continue
                pool_clips.append(np.concatenate(taken))
                pool_rows.append(
                    {"speaker": person, "duration": duration, "trial": trial, "members": [int(i) for i in members]}
                )
    print(f"  pool embeddings ({len(pool_clips)})", flush=True)
    pool_vectors = embed_clips(embed_batch, pool_clips)

    out = f"eval/real/{stem}.personemb.npz"
    np.savez_compressed(
        out,
        model=CHECKPOINT,
        span_vectors=span_vectors,
        span_meta=json.dumps(pieces),
        pool_vectors=pool_vectors,
        pool_meta=json.dumps(pool_rows),
    )
    print(f"wrote {out}", flush=True)


for argument in sys.argv[1:]:
    main(argument)
