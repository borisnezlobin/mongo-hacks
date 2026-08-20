"""Score any diarization output against the owner-verified reference spans.

One scorer for every candidate system, so pyannote 3.1, community-1 and NeMo are
compared on identical arithmetic rather than on each tool's own printout.

DER is computed only inside the reference's own annotated region. The references
label 93% of dorm-9pm but only 39% of dorm-40min, so scoring the unlabelled
remainder would be scoring silence against nothing and would flatter every
system equally. `excluded` regions named by the reference are removed as well.

  python eval/real/score_diarization.py <hypothesis.json> <stem>

Accepts either shape of diarization JSON: {"turns":[{start_ms,end_ms,speaker}]}
or {"segments":[{start,end,speaker}]} in seconds.
"""

import json
import sys
from collections import defaultdict

from pyannote.core import Annotation, Segment, Timeline
from pyannote.metrics.diarization import DiarizationErrorRate


def load_hypothesis(path: str) -> Annotation:
    payload = json.load(open(path))
    annotation = Annotation()
    if "turns" in payload:
        rows = [(t["start_ms"] / 1000, t["end_ms"] / 1000, t["speaker"]) for t in payload["turns"]]
    else:
        rows = [(t["start"], t["end"], t["speaker"]) for t in payload["segments"]]
    for start, end, speaker in rows:
        if end > start:
            annotation[Segment(start, end)] = str(speaker)
    return annotation


def load_reference(stem: str) -> tuple[Annotation, Timeline, int]:
    payload = json.load(open(f"eval/real/{stem}.reference.json"))
    reference = Annotation()
    for span in payload["spans"]:
        start, end = span["start_ms"] / 1000, span["end_ms"] / 1000
        if end > start:
            reference[Segment(start, end)] = span["speaker"]
    scored = reference.get_timeline().support()
    for span in payload.get("excluded", []):
        start, end = span["start_ms"] / 1000, span["end_ms"] / 1000
        scored = scored.extrude(Segment(start, end))
    return reference, scored, payload["truePeople"]


def report(hypothesis_path: str, stem: str) -> dict:
    hypothesis = load_hypothesis(hypothesis_path)
    reference, scored, true_people = load_reference(stem)

    metric = DiarizationErrorRate(collar=0.25, skip_overlap=False)
    der = metric(reference, hypothesis, uem=scored, detailed=True)

    mapping = metric.optimal_mapping(reference, hypothesis, uem=scored)
    inverse = {hyp: ref for hyp, ref in mapping.items()}

    # Per-person recall: of a person's reference seconds, how many land on the
    # hypothesis label that person was mapped to.
    hit = defaultdict(float)
    total = defaultdict(float)
    cropped_reference = reference.crop(scored)
    cropped_hypothesis = hypothesis.crop(scored)
    for ref_segment, _, person in cropped_reference.itertracks(yield_label=True):
        total[person] += ref_segment.duration
        for hyp_segment, _, label in cropped_hypothesis.itertracks(yield_label=True):
            overlap = ref_segment & hyp_segment
            if overlap and inverse.get(label) == person:
                hit[person] += overlap.duration

    # Purity: for each hypothesis label, the share of its labelled seconds that
    # belong to its most common reference person.
    per_label = defaultdict(lambda: defaultdict(float))
    for hyp_segment, _, label in cropped_hypothesis.itertracks(yield_label=True):
        for ref_segment, _, person in cropped_reference.itertracks(yield_label=True):
            overlap = hyp_segment & ref_segment
            if overlap:
                per_label[label][person] += overlap.duration

    pure_seconds = sum(max(people.values()) for people in per_label.values())
    label_seconds = sum(sum(people.values()) for people in per_label.values())
    purity = pure_seconds / label_seconds if label_seconds else 0.0

    speakers = len(hypothesis.labels())
    print(f"{stem}  <- {hypothesis_path}")
    print(
        f"  DER {100 * der['diarization error rate']:5.1f}%   "
        f"(miss {100 * der['missed detection'] / der['total']:.1f}%  "
        f"FA {100 * der['false alarm'] / der['total']:.1f}%  "
        f"conf {100 * der['confusion'] / der['total']:.1f}%)"
    )
    print(f"  speakers {speakers} vs {true_people} true people   label purity {100 * purity:.1f}%")
    for person in sorted(total):
        recall = 100 * hit[person] / total[person] if total[person] else 0.0
        print(f"    recall {person:10} {recall:5.1f}%  of {total[person]:6.1f}s")
    for label in sorted(per_label, key=lambda k: -sum(per_label[k].values())):
        people = per_label[label]
        detail = "  ".join(f"{p} {s:.0f}s" for p, s in sorted(people.items(), key=lambda kv: -kv[1]))
        print(f"    label {label:14} {sum(people.values()):6.1f}s labelled   {detail}")
    return {
        "der": der["diarization error rate"],
        "purity": purity,
        "speakers": speakers,
        "true_people": true_people,
    }


if __name__ == "__main__":
    report(sys.argv[1], sys.argv[2])
