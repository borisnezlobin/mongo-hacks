"""Pooled-audio voiceprints per diarization cluster, at several pool sizes.

The product builds a voiceprint by concatenating a cluster's clean audio and
embedding it once. Every study in this directory that needed a person model
approximated that by averaging the per-turn vectors instead, because the turn
vectors were already cached. The two are not interchangeable: on 50 seconds of
one person spread over ten turns, averaging the turn vectors scored 0.44 against
the same person in another recording where embedding the concatenated audio
scored 0.72. Short turns embed badly, and averaging a handful of bad vectors
does not fix them; it only makes a confident bad vector.

So this produces what the product actually holds -- one embedding per pooled
clip -- across a ladder of pool sizes, so "how much speech does a person need"
can be answered in the units the product uses.

  python eval/real/cluster_pools.py
  SPK_MODEL=speechbrain/spkrec-ecapa-voxceleb python eval/real/cluster_pools.py

Writes eval/real/<stem>.clusterpool.<tag>.npz. Real-people data: gitignored.
"""

import json
import os
import sys

import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from embedders import load  # noqa: E402

STEMS = ["dorm-9pm", "dorm-40min", "jerry-45min", "mentra-mtg"]
DURATIONS = [float(x) for x in os.environ.get("POOL_DURATIONS", "4,8,20,60,160").split(",")]
POOLS_PER_CELL = int(os.environ.get("POOLS_PER_CELL", 10))
MIN_PIECE_MS = 700
CHECKPOINT = os.environ.get("SPK_MODEL", "pyannote/wespeaker-voxceleb-resnet34-LM")
TAG = os.environ.get("POOL_TAG", "ecapa" if "ecapa" in CHECKPOINT else "wespeaker")


def exclusive_pieces(turns):
    """Per cluster, the stretches the segmentation heard nobody else in."""
    by_cluster = {}
    for turn in turns:
        pieces = [(turn["start_ms"], turn["end_ms"])]
        for other in turns:
            if other is turn or other["speaker"] == turn["speaker"]:
                continue
            if other["start_ms"] >= turn["end_ms"] or other["end_ms"] <= turn["start_ms"]:
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
            if hi - lo >= MIN_PIECE_MS:
                by_cluster.setdefault(turn["speaker"], []).append((lo / 1000, hi / 1000))
    return by_cluster


def main(stem: str, embed_batch) -> None:
    turns = json.load(open(f"fixtures/real/{stem}.pyannote.json"))["turns"]
    audio, sr = sf.read(f"fixtures/real/{stem}.wav", dtype="float32")
    by_cluster = exclusive_pieces(turns)
    rng = np.random.default_rng(0)

    clips, rows = [], []
    for cluster, pieces in sorted(by_cluster.items()):
        available = sum(hi - lo for lo, hi in pieces)
        if available < 20:
            continue
        for duration in DURATIONS:
            if available < duration * 1.6:
                continue
            for trial in range(POOLS_PER_CELL):
                order = list(rng.permutation(len(pieces)))
                taken, total, members = [], 0.0, []
                for index in order:
                    if total >= duration:
                        break
                    lo, hi = pieces[index]
                    take = min(hi - lo, duration - total)
                    taken.append(audio[int(lo * sr) : int((lo + take) * sr)])
                    total += take
                    members.append(index)
                if total < duration * 0.98:
                    continue
                clips.append(np.concatenate(taken))
                rows.append(
                    {
                        "cluster": cluster,
                        "duration": duration,
                        "trial": trial,
                        "members": [int(i) for i in members],
                        "available_s": round(available, 1),
                    }
                )
    print(f"{stem}: {len(by_cluster)} clusters, {len(clips)} pooled clips", flush=True)

    # Batched by total samples rather than by count. A batch of four 160-second
    # clips is ten minutes of audio in one forward pass, which paged this
    # machine to a standstill; the sample budget keeps every batch the same
    # size in memory whatever the pool length is.
    order = sorted(range(len(clips)), key=lambda index: len(clips[index]))
    batches, current = [], []
    budget = int(os.environ.get("BATCH_SECONDS", 60)) * sr
    for index in order:
        if current and (len(current) + 1) * len(clips[index]) > budget:
            batches.append(current)
            current = []
        current.append(index)
    if current:
        batches.append(current)

    vectors = None
    done = 0
    for start, group in enumerate(batches):
        width = max(len(clips[index]) for index in group)
        block = np.zeros((len(group), width), dtype="float32")
        for row, index in enumerate(group):
            block[row, : len(clips[index])] = clips[index]
        out = np.asarray(embed_batch(block), dtype="float64")
        out = out / np.linalg.norm(out, axis=1, keepdims=True)
        if vectors is None:
            vectors = np.zeros((len(clips), out.shape[1]))
        for row, index in enumerate(group):
            vectors[index] = out[row]
        done += len(group)
        if start % 20 == 0:
            print(f"  {done}/{len(order)}", flush=True)

    path = f"eval/real/{stem}.clusterpool.{TAG}.npz"
    np.savez_compressed(path, model=CHECKPOINT, vectors=vectors, meta=json.dumps(rows))
    # The same vectors as JSON, because the harness that drives the shipped
    # TypeScript matcher has to read them and bun does not read npz.
    for row, vector in zip(rows, vectors):
        row["vector"] = [round(float(x), 5) for x in vector]
    json.dump({"model": CHECKPOINT, "pools": rows}, open(path.replace(".npz", ".json"), "w"))
    print(f"wrote {path} and .json", flush=True)


embedder = load(CHECKPOINT)
for name in sys.argv[1:] or STEMS:
    main(name, embedder)
