"""How well can a speaker change be found by embeddings alone, at short range?

The segmentation model misses boundaries that the words prove are there. The
question this answers is whether anything downstream could find them: take two
adjacent stretches of audio either side of a candidate time, embed both, and
call the cosine distance between them a change score. If that score separates
real boundaries from the middle of one person talking, a change-point pass is
worth building; if it does not, no post-processing recovers what segmentation
dropped.

  python eval/real/changepoint_auc.py dorm-40min
  ANCHOR=words python eval/real/changepoint_auc.py dorm-40min

Two anchorings, because they are different claims:

  clock   candidates every so often, context is a fixed w-second window. This
          is what a blind change-point detector would do.
  words   candidates only at gaps between whisper words inside a turn, context
          is whole words out to w seconds. This is the version that gets clean
          speech on both sides instead of half a window of silence.

Positives are places where two adjacent diarization turns with DIFFERENT
speaker labels abut -- boundary times the segmentation model itself found, so
they are not this detector's own output being graded, and the embedding model
had no hand in choosing them. Negatives are candidates in the interior of a
single-speaker turn. Negatives are pessimistic on purpose: some of them are the
boundaries segmentation missed, which can only push the measured score down.

AUC is reported per context length so w can be taken off a plateau.
"""

import json
import os
import sys

import numpy as np
import soundfile as sf
import torch
from pyannote.audio.pipelines.speaker_verification import PretrainedSpeakerEmbedding

stem = sys.argv[1]
widths = [float(x) for x in (sys.argv[2].split(",") if len(sys.argv) > 2 else ["0.5", "0.75", "1.0", "1.5", "2.0"])]
checkpoint = os.environ.get("SPK_MODEL", "pyannote/wespeaker-voxceleb-resnet34-LM")
anchor = os.environ.get("ANCHOR", "clock")
guard = 0.05
MIN_SPEECH = 0.35  # below this the embedding model is reading noise

turns = sorted(
    json.load(open(f"fixtures/real/{stem}.pyannote.json"))["turns"],
    key=lambda turn: turn["start_ms"],
)
words = [
    word
    for word in json.load(open(f"fixtures/real/{stem}.whisper.json"))["words"]
    if word.get("start") is not None and word["end"] > word["start"]
]
audio, sr = sf.read(f"fixtures/real/{stem}.wav", dtype="float32")
embedder = PretrainedSpeakerEmbedding(checkpoint, token=os.environ["HF_TOKEN"])


def clock_context(at: float, w: float, turn) -> tuple | None:
    lo, hi = turn["start_ms"] / 1000, turn["end_ms"] / 1000
    if at - guard - w < lo or at + guard + w > hi:
        return None
    return (at - guard - w, at - guard), (at + guard, at + guard + w)


def word_context(at: float, w: float, turn) -> tuple | None:
    lo, hi = turn["start_ms"] / 1000, turn["end_ms"] / 1000
    left = [x for x in words if x["end"] <= at + 1e-6 and x["start"] >= max(lo, at - w)]
    right = [x for x in words if x["start"] >= at - 1e-6 and x["end"] <= min(hi, at + w)]
    if not left or not right:
        return None
    span = ((left[0]["start"], left[-1]["end"]), (right[0]["start"], right[-1]["end"]))
    if span[0][1] - span[0][0] < MIN_SPEECH or span[1][1] - span[1][0] < MIN_SPEECH:
        return None
    return span


context = word_context if anchor == "words" else clock_context


def score(pairs: list[tuple], batch: int = 32) -> np.ndarray:
    spans = [span for pair in pairs for span in pair]
    vectors = []
    for start in range(0, len(spans), batch):
        group = spans[start : start + batch]
        cut = [audio[int(lo * sr) : int(hi * sr)] for lo, hi in group]
        longest = max(len(clip) for clip in cut)
        padded = np.zeros((len(group), longest), dtype="float32")
        mask = np.zeros((len(group), longest), dtype=bool)
        for row, clip in enumerate(cut):
            padded[row, : len(clip)] = clip
            mask[row, : len(clip)] = True
        out = embedder(
            torch.from_numpy(padded).unsqueeze(1),
            masks=torch.from_numpy(mask).float(),
        )
        vectors.append(out / np.linalg.norm(out, axis=1, keepdims=True))
    vectors = np.concatenate(vectors)
    return 1 - np.sum(vectors[0::2] * vectors[1::2], axis=1)


def candidates(w: float) -> tuple[list, list]:
    positives, negatives = [], []
    for index, turn in enumerate(turns):
        lo, hi = turn["start_ms"] / 1000, turn["end_ms"] / 1000
        if index + 1 < len(turns):
            following = turns[index + 1]
            abuts = abs(turn["end_ms"] - following["start_ms"]) <= 20
            if abuts and turn["speaker"] != following["speaker"]:
                at = turn["end_ms"] / 1000
                merged = {
                    "start_ms": turn["start_ms"],
                    "end_ms": following["end_ms"],
                    "speaker": turn["speaker"],
                }
                span = context(at, w, merged)
                if span:
                    positives.append(span)
        if anchor == "words":
            inside = [x for x in words if x["start"] >= lo and x["end"] <= hi]
            times = [
                (inside[i]["end"] + inside[i + 1]["start"]) / 2 for i in range(len(inside) - 1)
            ]
        else:
            times = list(np.arange(lo + w + guard, hi - w - guard, 2 * (w + guard)))
        for at in times:
            span = context(at, w, turn)
            if span:
                negatives.append(span)
    return positives, negatives


print(f"{stem}: {len(turns)} turns, anchor={anchor}, embedding {checkpoint}")
rng = np.random.default_rng(0)
for w in widths:
    positives, negatives = candidates(w)
    if not positives:
        print(f"  w={w:.2f}s  no usable boundaries")
        continue
    if len(negatives) > 4 * len(positives):
        picked = rng.choice(len(negatives), size=4 * len(positives), replace=False)
        negatives = [negatives[i] for i in picked]
    pos, neg = score(positives), score(negatives)
    order = np.argsort(np.concatenate([pos, neg]))
    labels = np.concatenate([np.ones(len(pos)), np.zeros(len(neg))])[order]
    ranks = np.arange(1, len(labels) + 1)
    auc = (ranks[labels == 1].sum() - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg))
    print(
        f"  w={w:.2f}s  n+={len(pos):4d} n-={len(neg):4d}  AUC={auc:.3f}  "
        f"boundary median {np.median(pos):.3f}  interior median {np.median(neg):.3f}  "
        f"recall@interior-p95 {(pos > np.quantile(neg, 0.95)).mean():.2f}"
    )
