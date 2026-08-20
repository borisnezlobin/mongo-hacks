"""Is a recording that will not link a property of the audio or of the embedder?

One of the four real recordings refuses to link to the other three: the same
person, pooled from minutes of speech on both sides, scores 0.44 across it and
0.86-0.95 across the others. Before that becomes a story about rooms and
microphones it has to be checked against a model from a different lineage. If
every embedder fails on the same recording the audio is the cause; if only one
does, the embedder is.

This builds one pooled clip per person per recording -- the same seconds for
every model -- and prints the cross-recording matrix each model produces.

  python eval/real/model_transfer.py
  SPK_MODELS=a,b     comma-separated checkpoints to compare
  POOL_SECONDS=8,20  pool sizes; several answers "how much speech is enough"
  TRIALS=6           independent random pools per person per size
"""

import json
import os
import sys
from collections import defaultdict

import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from embedders import load  # noqa: E402

MODELS = os.environ.get(
    "SPK_MODELS",
    "pyannote/wespeaker-voxceleb-resnet34-LM,speechbrain/spkrec-ecapa-voxceleb,speechbrain/spkrec-xvect-voxceleb",
).split(",")
POOL_SECONDS = [float(x) for x in os.environ.get("POOL_SECONDS", "60").split(",")]
TRIALS = int(os.environ.get("TRIALS", 1))

# Cluster identities, with their provenance in cross-session-identity.mts. The
# dorm recordings use the owner's reference spans instead, which are stronger.
#
# jerry-45min/SPEAKER_03 as Tarun is OWNER-CONFIRMED. The mentra-mtg entries are
# not people: Alex, David and Brendan were all remote, so SPEAKER_00 is a laptop
# speaker carrying three voices. Rows involving it measure a channel.
CLUSTER_PEOPLE = {
    ("jerry-45min", "SPEAKER_04"): "boris",
    ("jerry-45min", "SPEAKER_03"): "tarun",
    ("mentra-mtg", "SPEAKER_02"): "boris",
    ("mentra-mtg", "SPEAKER_00"): "alex",
    ("mentra-mtg", "SPEAKER_03"): "brendan",
}


def reference_pieces(stem: str):
    """Owner-labelled spans with other speakers' overlaps cut out."""
    spans = json.load(open(f"eval/real/{stem}.reference.json"))["spans"]
    out = defaultdict(list)
    for span in spans:
        pieces = [(span["start_ms"], span["end_ms"])]
        for other in spans:
            if other is span or other["speaker"] == span["speaker"]:
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
        for lo, hi in pieces:
            if hi - lo >= 700:
                out[span["speaker"].lower()].append((lo / 1000, hi / 1000))
    return out


def cluster_pieces(stem: str):
    turns = json.load(open(f"fixtures/real/{stem}.pyannote.json"))["turns"]
    out = defaultdict(list)
    for index, turn in enumerate(turns):
        pieces = [(turn["start_ms"], turn["end_ms"])]
        for other in turns:
            if other is turn or other["speaker"] == turn["speaker"]:
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
        person = CLUSTER_PEOPLE.get((stem, turn["speaker"]))
        if person is None:
            continue
        for lo, hi in pieces:
            if hi - lo >= 700:
                out[person].append((lo / 1000, hi / 1000))
    return out


def main() -> None:
    rng = np.random.default_rng(0)
    clips, keys = [], []
    for stem in ["dorm-9pm", "dorm-40min", "jerry-45min", "mentra-mtg"]:
        pieces = reference_pieces(stem) if stem.startswith("dorm") else cluster_pieces(stem)
        audio, sr = sf.read(f"fixtures/real/{stem}.wav", dtype="float32")
        for person, spans in sorted(pieces.items()):
            for pool_s in POOL_SECONDS:
                for trial in range(TRIALS):
                    order = rng.permutation(len(spans))
                    taken, total = [], 0.0
                    for index in order:
                        if total >= pool_s:
                            break
                        lo, hi = spans[index]
                        take = min(hi - lo, pool_s - total)
                        taken.append(audio[int(lo * sr) : int((lo + take) * sr)])
                        total += take
                    if total < pool_s * 0.9:
                        continue
                    clips.append(np.concatenate(taken))
                    keys.append((stem, person, pool_s, trial, total))
    print(f"{len(clips)} pooled clips over {sorted({k[2] for k in keys})}s pool sizes")

    for checkpoint in MODELS:
        embed_batch = load(checkpoint)
        vectors = []
        for position, clip in enumerate(clips):
            # One at a time and unpadded: with several pool sizes in flight,
            # padding every clip to the longest would embed minutes of silence.
            out = np.asarray(embed_batch(clip.reshape(1, -1)), dtype="float64")[0]
            vectors.append(out / np.linalg.norm(out))
            if position % 25 == 0:
                print(f"  {position}/{len(clips)}", flush=True)
        vectors = np.array(vectors)
        print(f"\n{checkpoint}: cross-recording cosine by pool size")
        for pool_s in sorted({key[2] for key in keys}):
            same, different, worst = [], [], []
            for i in range(len(keys)):
                for j in range(i + 1, len(keys)):
                    if keys[i][0] == keys[j][0] or keys[i][2] != pool_s or keys[j][2] != pool_s:
                        continue
                    score = float(vectors[i] @ vectors[j])
                    if keys[i][1] == keys[j][1]:
                        same.append(score)
                        worst.append((score, keys[i][1], keys[i][0], keys[j][0]))
                    else:
                        different.append((score, keys[i][1], keys[i][0], keys[j][1], keys[j][0]))
            if not same:
                continue
            same_array = np.array(same)
            different_array = np.array([row[0] for row in different])
            print(f"  pool {pool_s:5.0f}s  same n={len(same):4d} p5 {np.percentile(same_array, 5):.3f} "
                  f"median {np.median(same_array):.3f} min {same_array.min():.3f}  |  "
                  f"different n={len(different):5d} p95 {np.percentile(different_array, 95):.3f} "
                  f"max {different_array.max():.3f}")
            sweep = "  ".join(
                f"{t:.2f}:{100 * (different_array >= t).mean():4.1f}/{100 * (same_array < t).mean():4.1f}"
                for t in [0.50, 0.55, 0.60, 0.65, 0.68, 0.72, 0.75, 0.80]
            )
            print(f"                false-accept/miss %  {sweep}")
            for score, person, left, right in sorted(worst)[:3]:
                print(f"                weakest genuine {score:.3f}  {person} {left} <-> {right}")
            for row in sorted(different, reverse=True)[:3]:
                print(f"                closest impostor {row[0]:.3f}  {row[1]}@{row[2]} <-> {row[3]}@{row[4]}")

        # Asymmetric: an enrolled print is usually backed by far more speech
        # than the cluster being matched against it. Scoring only equal pool
        # sizes answers a question the product never asks.
        sizes = sorted({key[2] for key in keys})
        print(f"\n  asymmetric: enrolled print (rows) against query cluster (columns), cross-recording")
        print("    " + "enrolled\\query".ljust(16) + "".join(f"{q:>26g}s" for q in sizes))
        for enrolled in sizes:
            cells = []
            for query in sizes:
                same, different = [], []
                for i in range(len(keys)):
                    for j in range(len(keys)):
                        if i == j or keys[i][0] == keys[j][0]:
                            continue
                        if keys[i][2] != enrolled or keys[j][2] != query:
                            continue
                        score = float(vectors[i] @ vectors[j])
                        (same if keys[i][1] == keys[j][1] else different).append(score)
                if not same or not different:
                    cells.append(" " * 27)
                    continue
                same_array, different_array = np.array(same), np.array(different)
                miss = 100 * (same_array < 0.68).mean()
                false_accept = 100 * (different_array >= 0.68).mean()
                cells.append(
                    f"  p5 {np.percentile(same_array, 5):.2f} miss {miss:4.1f}% fa {false_accept:4.1f}%"
                )
            print(f"    {enrolled:>14g}s" + "".join(cells))


if __name__ == "__main__":
    main()
