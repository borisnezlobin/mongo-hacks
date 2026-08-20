"""Cluster the confident stretches first, then assign the rest to those pools.

The premise under test is that a fragment should be matched against people the
system already knows rather than against another fragment. pyannote already has
the shape of that -- BaseClustering clusters only chunk-speakers holding at
least `min_active_ratio` of their chunk with nobody else active, then
nearest-centroid-assigns every slot -- so what is swept here is the three things
it does not offer:

  seeding    how a slot earns the right to define a pool. Total clean seconds is
             pyannote's rule. Longest CONTIGUOUS clean run is the alternative,
             because four seconds of clean speech scattered over eight snippets
             of a back-and-forth is a blended embedding, while four contiguous
             seconds is one person talking.
  freezing   whether a seed keeps the label its own clustering gave it, or is
             re-assigned to the nearest pool like everything else. pyannote
             re-assigns; its own comment says that measured better, on other
             data.
  abstention where a fragment that matches no pool well goes. pyannote's argmax
             has no such state; -2 is reserved for silence. Abstaining on a slot
             does not necessarily silence that speech, because chunks overlap by
             90% and a neighbour usually still covers it, which is the reason to
             measure the cost rather than assume it.

Writes fixture-shaped JSON into --out, so eval/real/score-candidates.mts reads a
sweep exactly the way it reads the shipping fixture.

  sidecar/.venv/bin/python eval/real/bootstrap_cluster.py dorm-9pm \
      --seed-clean 2 --seed-runs 0,1,2,3 --abstain 0,0.15,0.2
"""

import argparse
import json
import os
import sys
from itertools import product

import numpy as np
from pyannote.audio import Pipeline
from pyannote.core import SlidingWindowFeature
from scipy.spatial.distance import cdist

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cluster_stage2 import SHIPPING_THRESHOLD, load_stage1  # noqa: E402


def longest_clean_run(active_alone: np.ndarray) -> np.ndarray:
    """Longest contiguous run of overlap-free frames, per (chunk, local speaker)."""
    num_chunks, num_frames, num_local = active_alone.shape
    best = np.zeros((num_chunks, num_local), dtype=np.int32)
    running = np.zeros((num_chunks, num_local), dtype=np.int32)
    for frame in range(num_frames):
        on = active_alone[:, frame, :]
        running = np.where(on, running + 1, 0)
        best = np.maximum(best, running)
    return best


def agglomerate(pipeline, vectors, threshold, method, min_cluster_size, max_clusters=20):
    """pyannote's own AgglomerativeClustering.cluster on an arbitrary vector set.

    Delegated rather than reimplemented so the seeding half is bit-identical to
    the shipping pipeline's clustering and only the seed SET differs. Its
    min_cluster_size dissolution and its unit-normalize-then-euclidean handling
    of centroid linkage are subtle enough that a copy would drift.
    """
    if len(vectors) == 1:
        return np.zeros(1, dtype=np.int32)
    pipeline.instantiate(
        {
            "clustering": {"method": method, "min_cluster_size": min_cluster_size,
                           "threshold": threshold},
            "segmentation": {"min_duration_off": 0.0},
        }
    )
    return np.asarray(
        pipeline.clustering.cluster(
            vectors.copy(), min_clusters=1, max_clusters=max_clusters, num_clusters=None
        ),
        dtype=np.int32,
    )


def bootstrap(pipeline, segmentations, embeddings, params, seed_clean_s, seed_run_s,
              abstain_distance, abstain_margin, freeze_seeds, weight_pools):
    """Seed pools from confident slots, then place every slot against the pools.

    Returns hard clusters plus a per-slot report, so the assignment half can be
    scored separately from the seeding half.
    """
    num_chunks, num_frames, num_local = segmentations.data.shape
    frame_seconds = segmentations.sliding_window.duration / num_frames
    alone = segmentations.data.sum(axis=2, keepdims=True) == 1
    clean = segmentations.data * alone
    clean_s = clean.sum(axis=1) * frame_seconds
    run_s = longest_clean_run(clean > 0) * frame_seconds
    active_s = segmentations.data.sum(axis=1) * frame_seconds

    valid = ~np.isnan(embeddings).any(axis=-1)
    occupied = (active_s > 0) & valid
    seed = occupied & (clean_s >= seed_clean_s) & (run_s >= seed_run_s)
    if seed.sum() < 2:
        seed = occupied & (clean_s >= seed_clean_s)

    seed_chunk, seed_local = np.where(seed)
    seed_vectors = embeddings[seed_chunk, seed_local]
    seed_clusters = agglomerate(
        pipeline, seed_vectors, params["threshold"], params["method"],
        params["min_cluster_size"],
    )

    unit_seed = seed_vectors / np.linalg.norm(seed_vectors, axis=1, keepdims=True)
    weights = (
        (clean_s[seed_chunk, seed_local] if weight_pools else np.ones(len(seed_chunk)))
    )[:, None]
    num_pools = int(seed_clusters.max()) + 1
    centroids = np.vstack(
        [
            (unit_seed[seed_clusters == pool] * weights[seed_clusters == pool]).sum(axis=0)
            / max(weights[seed_clusters == pool].sum(), 1e-9)
            for pool in range(num_pools)
        ]
    )
    centroids /= np.linalg.norm(centroids, axis=1, keepdims=True)

    flat = embeddings.reshape(-1, embeddings.shape[-1])
    safe = np.nan_to_num(flat, nan=0.0)
    distance = cdist(safe, centroids, metric="cosine").reshape(num_chunks, num_local, num_pools)

    hard = np.full((num_chunks, num_local), -2, dtype=np.int8)
    order = np.argsort(distance, axis=2)
    best = np.take_along_axis(distance, order[:, :, :1], axis=2)[:, :, 0]
    second = (
        np.take_along_axis(distance, order[:, :, 1:2], axis=2)[:, :, 0]
        if num_pools > 1
        else np.full_like(best, np.inf)
    )
    choice = order[:, :, 0]

    accepted = occupied.copy()
    if abstain_distance > 0:
        accepted &= best <= abstain_distance
    if abstain_margin > 0:
        accepted &= (second - best) >= abstain_margin
    hard[accepted] = choice[accepted]
    if freeze_seeds:
        hard[seed_chunk, seed_local] = seed_clusters

    report = {
        "slots": int(occupied.sum()),
        "seeds": int(seed.sum()),
        "pools": num_pools,
        "abstained": int((occupied & ~accepted & ~seed).sum()) if freeze_seeds
        else int((occupied & ~accepted).sum()),
        "abstained_s": float(active_s[occupied & ~accepted].sum())
        if not freeze_seeds
        else float(active_s[occupied & ~accepted & ~seed].sum()),
        "occupied_s": float(active_s[occupied].sum()),
    }
    return hard, report


def to_turns(pipeline, segmentations, count, hard, upper=20):
    counted = SlidingWindowFeature(
        np.minimum(count.data, upper).astype(np.int8), count.sliding_window
    )
    inactive = np.sum(segmentations.data, axis=1) == 0
    hard = hard.copy()
    hard[inactive] = -2
    discrete = pipeline.reconstruct(segmentations, hard, counted)
    annotation = pipeline.to_annotation(
        discrete, min_duration_on=0.0, min_duration_off=pipeline.segmentation.min_duration_off
    )
    turns = [
        {
            "speaker": f"SPEAKER_{int(label):02d}" if isinstance(label, (int, np.integer)) else str(label),
            "start_ms": int(round(segment.start * 1000)),
            "end_ms": int(round(segment.end * 1000)),
        }
        for segment, _, label in annotation.itertracks(yield_label=True)
    ]
    turns.sort(key=lambda turn: (turn["start_ms"], turn["end_ms"]))
    return turns


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("stem")
    parser.add_argument("--out", default="eval/real/bootstrap")
    parser.add_argument("--thresholds", default=str(SHIPPING_THRESHOLD))
    parser.add_argument("--methods", default="centroid")
    parser.add_argument("--min-cluster-sizes", default="12")
    parser.add_argument("--seed-clean", default="2.0")
    parser.add_argument("--seed-runs", default="0.0")
    parser.add_argument("--abstain", default="0.0")
    parser.add_argument("--abstain-margins", default="0.0")
    parser.add_argument("--freeze", default="0")
    parser.add_argument("--weight-pools", default="0")
    args = parser.parse_args()

    os.makedirs(args.out, exist_ok=True)
    segmentations, count, embeddings, duration = load_stage1(args.stem)
    pipeline = Pipeline.from_pretrained(
        "pyannote/speaker-diarization-3.1", token=os.environ["HF_TOKEN"]
    )
    pipeline.instantiate(
        {
            "clustering": {"method": "centroid", "min_cluster_size": 12, "threshold": SHIPPING_THRESHOLD},
            "segmentation": {"min_duration_off": 0.0},
        }
    )

    floats = lambda text: [float(value) for value in text.split(",") if value != ""]
    ints = lambda text: [int(value) for value in text.split(",") if value != ""]

    for threshold, method, size, clean, run, abstain, margin, freeze, weight in product(
        floats(args.thresholds), args.methods.split(","), ints(args.min_cluster_sizes),
        floats(args.seed_clean), floats(args.seed_runs), floats(args.abstain),
        floats(args.abstain_margins), ints(args.freeze), ints(args.weight_pools),
    ):
        hard, report = bootstrap(
            pipeline, segmentations, embeddings,
            {"threshold": threshold, "method": method, "min_cluster_size": size},
            clean, run, abstain, margin, bool(freeze), bool(weight),
        )
        turns = to_turns(pipeline, segmentations, count, hard)
        speakers = sorted({turn["speaker"] for turn in turns})
        name = (
            f"{args.stem}__t{threshold:.4f}_{method}_m{size}_cl{clean}_run{run}"
            f"_ab{abstain}_mg{margin}_fz{freeze}_w{weight}"
        )
        config = {
            "threshold": threshold, "method": method, "min_cluster_size": size,
            "seed_clean_s": clean, "seed_run_s": run, "abstain_distance": abstain,
            "abstain_margin": margin, "freeze_seeds": freeze, "weight_pools": weight,
            **report,
        }
        with open(os.path.join(args.out, f"{name}.json"), "w") as handle:
            json.dump({"turns": turns, "speakers": speakers, "config": config}, handle)
        attributed = sum(turn["end_ms"] - turn["start_ms"] for turn in turns) / 1000
        print(
            f"{name}: {len(speakers)} speakers, {len(turns)} turns, {attributed:.0f}s attributed, "
            f"seeds {report['seeds']}/{report['slots']}, pools {report['pools']}, "
            f"abstained {report['abstained']} slots ({report['abstained_s']:.0f}s of slot time)",
            flush=True,
        )


if __name__ == "__main__":
    main()
