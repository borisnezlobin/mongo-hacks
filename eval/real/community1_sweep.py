"""Sweep community-1's VBx clustering over cached segmentation and embeddings.

Replays everything after the embedding stage, which is the only part that
depends on the VBx parameters, so a whole grid costs about what one pipeline run
costs. Reports DER, per-person recall, purity and speaker count for every cell,
because a DER that falls while a person's recall falls to zero is a merge
wearing a better number - which is exactly what the default threshold of 0.6
does to Tarun on dorm-9pm.

  python eval/real/community1_sweep.py <stem> [--write threshold,Fa,Fb]
"""

import argparse
import json
import os
import warnings

warnings.filterwarnings("ignore")

import numpy as np
import torch
from pyannote.audio import Pipeline
from pyannote.core import Annotation, Segment, SlidingWindow, SlidingWindowFeature

from score_diarization import load_reference

MAX_SPEAKERS = 20


def load_stage1(stem: str):
    cache = np.load(f"eval/real/{stem}.community1.stage1.npz")
    start, duration, step = cache["window"]
    window = SlidingWindow(start=float(start), duration=float(duration), step=float(step))
    segmentations = SlidingWindowFeature(cache["segmentations"], window)
    return segmentations, cache["embeddings"], float(cache["duration"][0])


def cluster(pipeline, segmentations, embeddings, threshold, fa, fb, num_speakers=None):
    pipeline.clustering.threshold = threshold
    pipeline.clustering.Fa = fa
    pipeline.clustering.Fb = fb

    hard_clusters, _, _ = pipeline.clustering(
        embeddings=embeddings,
        segmentations=segmentations,
        num_clusters=num_speakers,
        min_clusters=1,
        max_clusters=MAX_SPEAKERS,
    )

    count = pipeline.speaker_count(
        segmentations, pipeline._segmentation.model.receptive_field, warm_up=(0.0, 0.0)
    )
    count.data = np.minimum(count.data, MAX_SPEAKERS).astype(np.int8)

    inactive = np.sum(segmentations.data, axis=1) == 0
    hard_clusters = hard_clusters.copy()
    hard_clusters[inactive] = -2

    diarization = pipeline.to_annotation(
        pipeline.reconstruct(segmentations, hard_clusters, count),
        min_duration_on=0.0,
        min_duration_off=pipeline.segmentation.min_duration_off,
    )

    exclusive_count = count.__class__(np.minimum(count.data, 1).astype(np.int8),
                                      count.sliding_window)
    exclusive = pipeline.to_annotation(
        pipeline.reconstruct(segmentations, hard_clusters, exclusive_count),
        min_duration_on=0.0,
        min_duration_off=pipeline.segmentation.min_duration_off,
    )
    return diarization, exclusive


def evaluate(diarization: Annotation, stem: str):
    from pyannote.metrics.diarization import DiarizationErrorRate

    reference, scored, true_people = load_reference(stem)
    metric = DiarizationErrorRate(collar=0.25, skip_overlap=False)
    der = metric(reference, diarization, uem=scored, detailed=True)
    mapping = metric.optimal_mapping(reference, diarization, uem=scored)
    inverse = {hyp: ref for hyp, ref in mapping.items()}

    cropped_reference = reference.crop(scored)
    cropped_hypothesis = diarization.crop(scored)
    hit: dict[str, float] = {}
    total: dict[str, float] = {}
    per_label: dict[str, dict[str, float]] = {}
    for ref_segment, _, person in cropped_reference.itertracks(yield_label=True):
        total[person] = total.get(person, 0.0) + ref_segment.duration
        for hyp_segment, _, label in cropped_hypothesis.itertracks(yield_label=True):
            overlap = ref_segment & hyp_segment
            if not overlap:
                continue
            per_label.setdefault(label, {})
            per_label[label][person] = per_label[label].get(person, 0.0) + overlap.duration
            if inverse.get(label) == person:
                hit[person] = hit.get(person, 0.0) + overlap.duration

    pure = sum(max(v.values()) for v in per_label.values()) if per_label else 0.0
    labelled = sum(sum(v.values()) for v in per_label.values()) if per_label else 0.0
    recalls = {p: hit.get(p, 0.0) / total[p] for p in total}
    return {
        "der": der["diarization error rate"],
        "confusion": der["confusion"] / der["total"],
        "purity": pure / labelled if labelled else 0.0,
        "speakers": len(diarization.labels()),
        "recalls": recalls,
        "worst_recall": min(recalls.values()) if recalls else 0.0,
        "true_people": true_people,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("stem")
    parser.add_argument("--write", default=None, help="threshold,Fa,Fb to save as JSON")
    parser.add_argument("--thresholds", default="0.50,0.55,0.60,0.65,0.70,0.75,0.80")
    parser.add_argument("--fa", default="0.07")
    parser.add_argument("--fb", default="0.8")
    parser.add_argument("--shape", action="store_true",
                        help="report label counts only, for stems with no reference")
    args = parser.parse_args()

    pipeline = Pipeline.from_pretrained(
        "pyannote/speaker-diarization-community-1", token=os.environ["HF_TOKEN"]
    )
    segmentations, embeddings, _ = load_stage1(args.stem)

    if args.write:
        threshold, fa, fb = (float(x) for x in args.write.split(","))
        diarization, exclusive = cluster(pipeline, segmentations, embeddings, threshold, fa, fb)
        for name, annotation in (("", diarization), (".exclusive", exclusive)):
            turns = [
                {"start_ms": int(round(s.start * 1000)), "end_ms": int(round(s.end * 1000)),
                 "speaker": str(label)}
                for s, _, label in annotation.itertracks(yield_label=True)
            ]
            turns.sort(key=lambda t: (t["start_ms"], t["end_ms"]))
            # The parameters go in the filename: a file called "tuned" is a
            # file whose settings nobody can recover a week later.
            path = (f"eval/real/{args.stem}.community1"
                    f".t{threshold:g}-fa{fa:g}-fb{fb:g}{name}.json")
            json.dump({"turns": turns}, open(path, "w"))
            print(f"wrote {path}: {len(turns)} turns, {len({t['speaker'] for t in turns})} speakers")
        raise SystemExit

    if args.shape:
        # jerry-45min and mentra-mtg have no reference spans, so DER is not
        # available. Speaker count and the share held by the biggest label still
        # are, and on mentra-mtg those are the whole complaint: 4 labels for 5
        # people with one label holding 67% of the speech.
        print(f"{args.stem}   (no reference; reporting label shape only)")
        print(f"{'thr':>5} {'Fa':>5} {'Fb':>5} {'spk':>4} {'top share':>10}  seconds per label")
        for threshold in [float(x) for x in args.thresholds.split(",")]:
            for fa in [float(x) for x in args.fa.split(",")]:
                for fb in [float(x) for x in args.fb.split(",")]:
                    _, exclusive = cluster(
                        pipeline, segmentations, embeddings, threshold, fa, fb)
                    per_label = exclusive.chart()
                    total = sum(seconds for _, seconds in per_label) or 1e-9
                    detail = " ".join(f"{seconds:.0f}s" for _, seconds in per_label)
                    print(f"{threshold:5.2f} {fa:5.2f} {fb:5.2f} {len(per_label):4d} "
                          f"{100 * per_label[0][1] / total:9.0f}%  {detail}")
        raise SystemExit

    print(f"{args.stem}   (reference names {load_reference(args.stem)[2]} people)")
    print(f"{'thr':>5} {'Fa':>5} {'Fb':>5} {'spk':>4} {'DER':>7} {'conf':>7} {'purity':>7}  "
          f"{'worst recall':>12}  per-person recall")
    for threshold in [float(x) for x in args.thresholds.split(",")]:
        for fa in [float(x) for x in args.fa.split(",")]:
            for fb in [float(x) for x in args.fb.split(",")]:
                diarization, exclusive = cluster(
                    pipeline, segmentations, embeddings, threshold, fa, fb)
                scores = evaluate(exclusive, args.stem)
                detail = " ".join(f"{p} {100 * r:.0f}%" for p, r in sorted(scores["recalls"].items()))
                print(f"{threshold:5.2f} {fa:5.2f} {fb:5.2f} {scores['speakers']:4d} "
                      f"{100 * scores['der']:6.1f}% {100 * scores['confusion']:6.1f}% "
                      f"{100 * scores['purity']:6.1f}% {100 * scores['worst_recall']:11.0f}%  {detail}")
