"""Re-cluster a cached pyannote stage one under many hyper-parameters.

Reads eval/real/<stem>.stage1.npz and runs the real pipeline's own clustering,
reconstruction and annotation code over it, so what comes out is what
speaker-diarization-3.1 would have produced with those parameters -- not a
re-implementation that agrees with the pipeline only where it was tested.

  python eval/real/cluster_stage2.py dorm-9pm --out eval/real/candidates

Each configuration lands as a fixture-shaped JSON so the TypeScript scorer can
read it exactly the way it reads the shipping fixture.
"""

import argparse
import json
import os
from itertools import product

import numpy as np
import torch
from pyannote.audio import Pipeline
from pyannote.core import Segment, SlidingWindow, SlidingWindowFeature

SHIPPING_THRESHOLD = 0.7045654963945799


def load_stage1(stem):
    cached = np.load(f"eval/real/{stem}.stage1.npz")
    segmentations = SlidingWindowFeature(
        cached["segmentations"],
        SlidingWindow(
            start=float(cached["seg_start"]),
            duration=float(cached["seg_duration"]),
            step=float(cached["seg_step"]),
        ),
    )
    count = SlidingWindowFeature(
        cached["count"],
        SlidingWindow(
            start=float(cached["count_start"]),
            duration=float(cached["count_duration"]),
            step=float(cached["count_step"]),
        ),
    )
    return segmentations, count, cached["embeddings"], float(cached["duration"])


def merge_on_pooled_centroids(hard_clusters, embeddings, segmentations, threshold):
    """Second pass: join labels whose pooled voiceprints are close.

    Clustering decides on chunk-local embeddings, each computed from a few
    seconds of one 10 s window. A label's pooled centroid is computed from every
    chunk it won -- minutes of speech for anyone who talks much -- so it is a far
    stronger piece of evidence about who a label is than any vector that went
    into building it. Over-splitting a talkative person is exactly the error that
    survives the first pass and is obvious to the second.

    Weighted by how much speech each chunk-speaker actually contributes, because
    an embedding computed from 0.4 s of audio should not count the same as one
    computed from 8 s.
    """
    if threshold <= 0:
        return hard_clusters
    labels = sorted(int(label) for label in np.unique(hard_clusters) if label >= 0)
    if len(labels) < 2:
        return hard_clusters

    weights = segmentations.data.sum(axis=1)  # (chunks, local speakers), in frames
    centroids = {}
    for label in labels:
        mask = (hard_clusters == label) & ~np.isnan(embeddings).any(axis=-1)
        if not mask.any():
            continue
        vectors = embeddings[mask]
        weight = weights[mask][:, None]
        vectors = vectors / np.linalg.norm(vectors, axis=1, keepdims=True)
        pooled = (vectors * weight).sum(axis=0) / max(weight.sum(), 1e-9)
        centroids[label] = pooled / np.linalg.norm(pooled)

    present = [label for label in labels if label in centroids]
    groups = [[label] for label in present]
    while len(groups) > 1:
        best = None
        for first in range(len(groups)):
            for second in range(first + 1, len(groups)):
                distance = max(
                    1.0 - float(centroids[a] @ centroids[b])
                    for a in groups[first]
                    for b in groups[second]
                )
                if best is None or distance < best[0]:
                    best = (distance, first, second)
        if best[0] >= threshold:
            break
        _, first, second = best
        groups[first] += groups[second]
        groups.pop(second)

    remap = {}
    for index, group in enumerate(groups):
        for label in group:
            remap[label] = index
    merged = hard_clusters.copy()
    for label, target in remap.items():
        merged[hard_clusters == label] = target
    return merged


def cluster(pipeline, segmentations, count, embeddings, params, num_speakers=None,
            min_speakers=None, max_speakers=None, merge_threshold=0.0,
            min_active_ratio=0.2):
    """The tail of SpeakerDiarization.apply, from clustering onward.

    `min_active_ratio` is how much of a ten-second chunk a speaker must hold
    alone before their embedding is allowed to train the clustering -- 0.2, two
    seconds, in pyannote. It is not a hyper-parameter there, it is a default
    argument, so it is swept here by binding it rather than by instantiating it.
    It is the knob that decides how much of the vector set is computed from
    enough audio to mean anything.
    """
    pipeline.instantiate(params)
    original_filter = type(pipeline.clustering).filter_embeddings
    pipeline.clustering.filter_embeddings = lambda embeddings, segmentations=None, **kwargs: (
        original_filter(pipeline.clustering, embeddings, segmentations=segmentations,
                        min_active_ratio=min_active_ratio)
    )
    lower = 1 if min_speakers is None else min_speakers
    upper = 20 if max_speakers is None else max_speakers
    if num_speakers is not None:
        lower = upper = num_speakers

    hard_clusters, _, _ = pipeline.clustering(
        embeddings=embeddings,
        segmentations=segmentations,
        num_clusters=num_speakers,
        min_clusters=lower,
        max_clusters=upper,
        frames=pipeline._segmentation.model.receptive_field,
    )
    hard_clusters = merge_on_pooled_centroids(
        hard_clusters, embeddings, segmentations, merge_threshold
    )
    counted = SlidingWindowFeature(
        np.minimum(count.data, upper).astype(np.int8), count.sliding_window
    )
    inactive = np.sum(segmentations.data, axis=1) == 0
    hard_clusters[inactive] = -2
    discrete = pipeline.reconstruct(segmentations, hard_clusters, counted)
    annotation = pipeline.to_annotation(
        discrete,
        min_duration_on=0.0,
        min_duration_off=pipeline.segmentation.min_duration_off,
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


def split_parts(segmentations, count, embeddings, parts):
    """Equal slices of a recording, each with its own absolute-time window."""
    if parts <= 1:
        return [(segmentations, count, embeddings, (0, None))]
    num_chunks = segmentations.data.shape[0]
    edges = [round(index * num_chunks / parts) for index in range(parts + 1)]
    window = segmentations.sliding_window
    out = []
    for index in range(parts):
        first, last = edges[index], edges[index + 1]
        start = window.start + first * window.step
        piece = SlidingWindowFeature(
            segmentations.data[first:last],
            SlidingWindow(start=start, duration=window.duration, step=window.step),
        )
        end = start + (last - first - 1) * window.step + window.duration
        counts = count.crop(
            Segment(start, end), mode="loose", return_data=False
        )
        out.append((piece, counts, embeddings[first:last],
                    (int(start * 1000), int(end * 1000))))
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("stem")
    parser.add_argument("--out", default="eval/real/candidates")
    parser.add_argument("--thresholds", default="")
    parser.add_argument("--min-cluster-sizes", default="12")
    parser.add_argument("--methods", default="centroid")
    parser.add_argument("--min-duration-off", default="0.0")
    parser.add_argument("--num-speakers", default="")
    parser.add_argument("--min-speakers", default="")
    parser.add_argument("--merge-thresholds", default="0.0")
    parser.add_argument("--min-active-ratios", default="0.2")
    parser.add_argument(
        "--parts", type=int, default=1,
        help="cluster this many equal slices of the recording independently, as a "
             "stand-in for separate recordings. There is no third recording to hold "
             "out, so this is the only available check that a setting is not fitted "
             "to one particular mixture of people and durations.",
    )
    args = parser.parse_args()

    os.makedirs(args.out, exist_ok=True)
    segmentations, count, embeddings, duration = load_stage1(args.stem)
    slices = split_parts(segmentations, count, embeddings, args.parts)

    pipeline = Pipeline.from_pretrained(
        "pyannote/speaker-diarization-3.1", token=os.environ["HF_TOKEN"]
    )

    thresholds = (
        [float(value) for value in args.thresholds.split(",") if value]
        or [SHIPPING_THRESHOLD]
    )
    sizes = [int(value) for value in args.min_cluster_sizes.split(",") if value]
    methods = [value for value in args.methods.split(",") if value]
    offs = [float(value) for value in args.min_duration_off.split(",") if value != ""]
    nums = [int(value) for value in args.num_speakers.split(",") if value] or [None]
    mins = [int(value) for value in args.min_speakers.split(",") if value] or [None]
    merges = [float(value) for value in args.merge_thresholds.split(",") if value != ""]
    ratios = [float(value) for value in args.min_active_ratios.split(",") if value != ""]

    for (threshold, size, method, off, num, low, merge, ratio), (part, piece) in product(
        product(thresholds, sizes, methods, offs, nums, mins, merges, ratios),
        enumerate(slices),
    ):
        part_segmentations, part_count, part_embeddings, window = piece
        params = {
            "clustering": {"method": method, "min_cluster_size": size, "threshold": threshold},
            "segmentation": {"min_duration_off": off},
        }
        turns = cluster(
            pipeline, part_segmentations, part_count, part_embeddings, params,
            num_speakers=num, min_speakers=low, merge_threshold=merge,
            min_active_ratio=ratio,
        )
        speakers = sorted({turn["speaker"] for turn in turns})
        name = (
            f"{args.stem}__t{threshold:.4f}_m{size}_{method}_off{off}"
            f"_n{num if num else 'auto'}_lo{low if low else 'auto'}_mg{merge}_ar{ratio}" + (f"_part{part}of{args.parts}" if args.parts > 1 else "")
        )
        path = os.path.join(args.out, f"{name}.json")
        with open(path, "w") as handle:
            json.dump(
                {
                    "turns": turns,
                    "speakers": speakers,
                    "config": {
                        "threshold": threshold, "min_cluster_size": size, "method": method,
                        "min_duration_off": off, "num_speakers": num, "min_speakers": low,
                        "merge_threshold": merge, "min_active_ratio": ratio,
                        "window_from_ms": window[0], "window_to_ms": window[1],
                    },
                },
                handle,
            )
        attributed = sum(turn["end_ms"] - turn["start_ms"] for turn in turns) / 1000
        print(
            f"{name}: {len(speakers)} speakers, {len(turns)} turns, {attributed:.0f}s",
            flush=True,
        )


if __name__ == "__main__":
    main()
