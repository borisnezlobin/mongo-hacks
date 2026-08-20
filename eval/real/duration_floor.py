"""How long must a stretch of speech be before this microphone can identify it?

Every fix downstream of segmentation -- change-point detection, re-clustering,
splitting a turn at a word gap -- ends up asking a speaker-embedding model to
compare two short pieces of audio. So the useful question is not "did the
detector fire" but "at what duration do same-speaker and different-speaker
distances stop overlapping". That number is a property of the room and the
microphone, and it bounds everything built on top.

  python eval/real/duration_floor.py dorm-40min eval/real/dorm-40min.reference.json

Clips are cut from inside single reference spans, so each one is one person
talking. Same-speaker pairs come from different spans by the same person --
never two halves of one span, which would measure the recording conditions of a
single moment rather than the person.

Reported per duration: AUC and equal error rate for the decision "same person?".
"""

import json
import os
import sys

import numpy as np
import soundfile as sf
import torch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from embedders import load  # noqa: E402

stem, reference_path = sys.argv[1], sys.argv[2]
durations = [float(x) for x in (sys.argv[3].split(",") if len(sys.argv) > 3 else ["0.5", "1", "2", "4", "8", "16"])]
checkpoint = os.environ.get("SPK_MODEL", "pyannote/wespeaker-voxceleb-resnet34-LM")
PAIRS = int(os.environ.get("PAIRS", 300))

spans = json.load(open(reference_path))["spans"]
audio, sr = sf.read(os.environ.get("ENHANCE_WAV", f"fixtures/real/{stem}.wav"), dtype="float32")
embed_batch = load(checkpoint)
rng = np.random.default_rng(0)


def clips_of(duration: float) -> dict[str, list[tuple[float, float]]]:
    """One clip per span long enough to hold one, so no pair shares a span."""
    out: dict[str, list[tuple[float, float]]] = {}
    for span in spans:
        lo, hi = span["start_ms"] / 1000, span["end_ms"] / 1000
        if hi - lo < duration:
            continue
        at = lo + (hi - lo - duration) / 2
        out.setdefault(span["speaker"], []).append((at, at + duration))
    return out


def embed(spans_to_embed: list[tuple[float, float]], batch: int = 32) -> np.ndarray:
    vectors = []
    for start in range(0, len(spans_to_embed), batch):
        group = spans_to_embed[start : start + batch]
        width = max(int((hi - lo) * sr) for lo, hi in group)
        block = np.zeros((len(group), width), dtype="float32")
        for row, (lo, hi) in enumerate(group):
            clip = audio[int(lo * sr) : int(lo * sr) + width]
            block[row, : len(clip)] = clip
        out = np.asarray(embed_batch(block), dtype="float64")
        vectors.append(out / np.linalg.norm(out, axis=1, keepdims=True))
    return np.concatenate(vectors)


print(f"{stem}: {len(spans)} reference spans, embedding {checkpoint}")
for duration in durations:
    by_speaker = clips_of(duration)
    people = [p for p, clips in by_speaker.items() if len(clips) >= 2]
    if len(people) < 2:
        print(f"  {duration:5.1f}s  not enough reference spans this long")
        continue
    flat = [(person, clip) for person in people for clip in by_speaker[person]]
    if len(flat) > 400:
        flat = [flat[i] for i in rng.choice(len(flat), 400, replace=False)]
    vectors = embed([clip for _, clip in flat])
    labels = np.array([person for person, _ in flat])
    same, different = [], []
    for i in range(len(flat)):
        for j in range(i + 1, len(flat)):
            distance = 1 - float(np.dot(vectors[i], vectors[j]))
            (same if labels[i] == labels[j] else different).append(distance)
    same, different = np.array(same), np.array(different)
    if len(same) > PAIRS:
        same = rng.choice(same, PAIRS, replace=False)
    if len(different) > PAIRS:
        different = rng.choice(different, PAIRS, replace=False)
    order = np.argsort(np.concatenate([different, same]))
    marks = np.concatenate([np.ones(len(different)), np.zeros(len(same))])[order]
    ranks = np.arange(1, len(marks) + 1)
    auc = (ranks[marks == 1].sum() - len(different) * (len(different) + 1) / 2) / (
        len(different) * len(same)
    )
    grid = np.linspace(0, 2, 401)
    false_accept = np.array([(different <= t).mean() for t in grid])
    false_reject = np.array([(same > t).mean() for t in grid])
    eer_at = int(np.argmin(np.abs(false_accept - false_reject)))
    print(
        f"  {duration:5.1f}s  clips={len(flat):3d} people={len(people)}  AUC={auc:.3f}  "
        f"EER={(false_accept[eer_at] + false_reject[eer_at]) / 2:.2f} at d={grid[eer_at]:.2f}  "
        f"same median {np.median(same):.3f}  different median {np.median(different):.3f}"
    )
