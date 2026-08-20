"""Why do two pools of the same person, from different windows, barely agree?

The windowed Sortformer system links window-local speakers by pooled embedding,
and an ablation showed the linking works exactly as well with the voice
similarity thrown away entirely. That says the pooled vectors carry almost no
usable signal across windows, which sits badly next to a separate result that
pooled models transfer across whole recordings with no false accepts.

Four explanations, and they make different predictions, so they can be told
apart rather than argued about:

  short-window noise   separation improves as pooled seconds grow
  pool impurity        separation improves when dirty pools are excluded
  drift over time      same-person similarity falls as the windows get further
                       apart, and does so even for clean, long pools
  position or distance  no clean signature here; what is left when the other
                       three are excluded, and a reason to look at the audio

Every pair is labelled by the reference, so only recordings with reference spans
can be used. Pairs from the same window are dropped: Sortformer already says
those are different people, and they are not the question.

READ THE OPERATING-POINT TABLE BEFORE QUOTING A ZERO-FALSE-MERGE RESULT. A
threshold high enough to accept nobody wrongly also accepts almost nobody: on
dorm-40min these pairs give 0.0% false accepts at 0.75 while keeping 11.3% of
genuine matches, and 0.8% at 0.65 while keeping 27.7%. "No false merges across
N trials" is a statement about precision only. A system tuned there is safe and
will under-link, splitting one person into several records rather than fusing
two people -- the right direction to err, and the reason a duplicates review
exists, but not the same claim as getting identity right.

The same tool answers that question for cross-RECORDING pools, which is where
the identity lane's thresholds are actually applied; this file only measures
across windows of one recording, which is the easier case.

  python eval/real/pool_drift.py <stem> [...]
"""

import json
import os
import sys
import warnings

warnings.filterwarnings("ignore")

import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sortformer_pooled import clean_spans, pool_audio  # noqa: E402

WINDOW_SECONDS = float(os.environ.get("WINDOW_SECONDS", 90))
HOP_SECONDS = float(os.environ.get("HOP_SECONDS", 45))
POOL_CAP = float(os.environ.get("POOL_CAP", 20))
EMBEDDER = os.environ.get("EMBEDDER", "pyannote/wespeaker-voxceleb-resnet34-LM")


def auc(same: np.ndarray, different: np.ndarray) -> float:
    """Chance that a same-person pair outscores a different-person pair."""
    if len(same) == 0 or len(different) == 0:
        return float("nan")
    return float((same[:, None] > different[None, :]).mean()
                 + 0.5 * (same[:, None] == different[None, :]).mean())


def report(name, same, different):
    same, different = np.asarray(same), np.asarray(different)
    if len(same) < 5 or len(different) < 5:
        print(f"  {name:34} too few pairs ({len(same)} same, {len(different)} different)")
        return
    print(f"  {name:34} AUC {auc(same, different):.3f}   "
          f"same {same.mean():.3f}+-{same.std():.3f} ({len(same)})   "
          f"diff {different.mean():.3f}+-{different.std():.3f} ({len(different)})")


for stem in sys.argv[1:]:
    cache = f"eval/real/{stem}.sortformer-windows-w{WINDOW_SECONDS:g}-h{HOP_SECONDS:g}.json"
    rows = json.load(open(cache))["rows"]
    spans = json.load(open(f"eval/real/{stem}.reference.json"))["spans"]

    audio, sample_rate = sf.read(f"fixtures/real/{stem}.wav", dtype="float32")
    if audio.ndim > 1:
        audio = audio.mean(axis=1)

    from embedders import load
    embed = load(EMBEDDER)

    entries = []
    for window_index in sorted({r["window"] for r in rows}):
        for local in sorted({r["local"] for r in rows if r["window"] == window_index}):
            mine = clean_spans(rows, window_index, local)
            seconds = sum(end - start for start, end in mine)
            if seconds < 1.0:
                continue
            held: dict[str, float] = {}
            for start, end in mine:
                for span in spans:
                    overlap = min(end, span["end_ms"] / 1000) - max(start, span["start_ms"] / 1000)
                    if overlap > 0:
                        held[span["speaker"]] = held.get(span["speaker"], 0.0) + overlap
            labelled = sum(held.values())
            if labelled < 1.0:
                continue
            person = max(held, key=lambda p: held[p])
            vector = np.asarray(
                embed(pool_audio(audio, mine, POOL_CAP)[None, :].astype(np.float32))[0],
                dtype=np.float64).ravel()
            entries.append({
                "window": window_index,
                "person": person,
                "purity": held[person] / labelled,
                "seconds": min(seconds, POOL_CAP),
                "vector": vector / (np.linalg.norm(vector) + 1e-9),
            })

    print(f"\n{stem}: {len(entries)} reference-labelled pools "
          f"(window {WINDOW_SECONDS:g}s, hop {HOP_SECONDS:g}s, cap {POOL_CAP:g}s)")
    if len(entries) < 4:
        continue

    pairs = []
    for i in range(len(entries)):
        for j in range(i + 1, len(entries)):
            a, b = entries[i], entries[j]
            if a["window"] == b["window"]:
                continue
            pairs.append({
                "same": a["person"] == b["person"],
                "cosine": float(a["vector"] @ b["vector"]),
                "purity": min(a["purity"], b["purity"]),
                "seconds": min(a["seconds"], b["seconds"]),
                "gap": abs(a["window"] - b["window"]) * HOP_SECONDS,
            })

    def split(rows_in):
        return ([p["cosine"] for p in rows_in if p["same"]],
                [p["cosine"] for p in rows_in if not p["same"]])

    print(" all cross-window pairs")
    report("everything", *split(pairs))

    print(" short-window noise: by pooled seconds of the shorter pool")
    for lo, hi in [(1, 4), (4, 10), (10, 20), (20, 1e9)]:
        chosen = [p for p in pairs if lo <= p["seconds"] < hi]
        report(f"{lo:g}-{hi:g}s", *split(chosen))

    print(" pool impurity: by purity of the dirtier pool")
    for floor in [0.0, 0.7, 0.85, 0.95, 0.999]:
        chosen = [p for p in pairs if p["purity"] >= floor]
        report(f"purity >= {floor:.3f}", *split(chosen))

    print(" operating points: what a fixed threshold does to these pairs")
    same_all = np.array([p["cosine"] for p in pairs if p["same"]])
    diff_all = np.array([p["cosine"] for p in pairs if not p["same"]])
    print(f"  {'threshold':34} {'false accept':>13} {'true matches kept':>18}")
    for cut in [0.35, 0.45, 0.55, 0.65, 0.75]:
        print(f"  {cut:<34.2f} {100 * (diff_all >= cut).mean():12.1f}% "
              f"{100 * (same_all >= cut).mean():17.1f}%")

    print(" drift over time: by gap, on clean long pools only")
    clean = [p for p in pairs if p["purity"] >= 0.95 and p["seconds"] >= 10]
    for lo, hi in [(0, 120), (120, 360), (360, 900), (900, 1e9)]:
        chosen = [p for p in clean if lo <= p["gap"] < hi]
        report(f"gap {lo:g}-{hi:g}s", *split(chosen))
