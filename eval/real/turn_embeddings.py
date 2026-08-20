"""One embedding per diarization turn, cached so the clustering sweep is cheap.

Bootstrapping needs a vector per turn rather than per pyannote analysis window:
the question is which turns are the same voice, and the turn is the unit the
join and every landmark are expressed in. Only the EXCLUSIVE part of each turn
is embedded -- the stretches where the segmentation heard nobody else -- because
a fragment spoken over somebody else describes both of them, and pooling that
into a voice is how two people become one.

  python eval/real/turn_embeddings.py dorm-40min

Writes eval/real/<stem>.turnemb.json: one row per turn, in the order the
diarization emitted them, with the vector and how much clean speech it was
computed from. Real-people data, so it stays in the repo and stays gitignored.
"""

import json
import os
import sys

import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from embedders import load  # noqa: E402

stem = sys.argv[1]
checkpoint = os.environ.get("SPK_MODEL", "pyannote/wespeaker-voxceleb-resnet34-LM")
POOL_CAP_S = float(os.environ.get("POOL_CAP_S", 20.0))
MIN_SPEECH_S = 0.20

turns = json.load(open(f"fixtures/real/{stem}.pyannote.json"))["turns"]
audio, sr = sf.read(f"fixtures/real/{stem}.wav", dtype="float32")
embed_batch = load(checkpoint)


def exclusive_pieces(index: int) -> list[tuple[float, float]]:
    """The parts of this turn no other speaker's turn covers."""
    turn = turns[index]
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
    return [(lo / 1000, hi / 1000) for lo, hi in pieces]


rows = []
clips = []
for index in range(len(turns)):
    pieces = exclusive_pieces(index)
    # Concatenating the clean pieces is what pooling means here: the embedding
    # model is being asked "whose voice is this", and silence between two of
    # somebody's own words is not evidence against them.
    kept = []
    total = 0.0
    for lo, hi in pieces:
        if total >= POOL_CAP_S:
            break
        take = min(hi - lo, POOL_CAP_S - total)
        kept.append(audio[int(lo * sr) : int((lo + take) * sr)])
        total += take
    rows.append(
        {
            "start_ms": turns[index]["start_ms"],
            "end_ms": turns[index]["end_ms"],
            "speaker": turns[index]["speaker"],
            "exclusive_ms": round(total * 1000),
        }
    )
    clips.append(np.concatenate(kept) if kept and total >= MIN_SPEECH_S else None)

# Sorted by length before batching. Padding is to the longest clip in a batch,
# so mixing a twenty-second stretch with fifteen half-second fragments costs
# thirty times the audio it needs to; that turned a three-minute job into hours.
usable = sorted(
    (index for index, clip in enumerate(clips) if clip is not None),
    key=lambda index: len(clips[index]),
)
print(f"{stem}: {len(turns)} turns, {len(usable)} with at least {MIN_SPEECH_S}s of clean speech", flush=True)

vectors: dict[int, list[float]] = {}
BATCH = 16
for start in range(0, len(usable), BATCH):
    group = usable[start : start + BATCH]
    width = max(len(clips[index]) for index in group)
    block = np.zeros((len(group), width), dtype="float32")
    for row, index in enumerate(group):
        block[row, : len(clips[index])] = clips[index]
    out = np.asarray(embed_batch(block), dtype="float64")
    out = out / np.linalg.norm(out, axis=1, keepdims=True)
    for row, index in enumerate(group):
        vectors[index] = [round(float(x), 5) for x in out[row]]
    if (start // BATCH) % 10 == 0:
        print(f"  {start}/{len(usable)}", flush=True)

for index, row in enumerate(rows):
    row["vector"] = vectors.get(index)

# TURNEMB_SUFFIX keeps a second model's vectors beside the shipping model's
# rather than on top of them: the cache is keyed by stem alone, so running this
# with SPK_MODEL set used to silently replace the wespeaker cache every other
# script in this directory reads.
out_path = f"eval/real/{stem}.turnemb{os.environ.get('TURNEMB_SUFFIX', '')}.json"
json.dump({"model": checkpoint, "turns": rows}, open(out_path, "w"))
print(f"wrote {out_path}", flush=True)
