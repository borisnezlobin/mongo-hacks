"""How much speech sits inside a diarization turn that holds two people?

One missed boundary is an anecdote. This counts them: every turn the pipeline
emits is intersected with the reference spans, and a turn covering two different
labelled people is a turn no clustering, join or naming step can ever get right,
because there is no seam in it to cut.

  python eval/real/turn_purity.py dorm-40min eval/real/dorm-40min.reference.json

Only turns with at least MIN_LABELLED seconds of labelled speech are counted, so
the answer is about places the reference actually speaks to.
"""

import json
import sys

stem, reference_path = sys.argv[1], sys.argv[2]
MIN_LABELLED = 0.5

turns = json.load(open(f"fixtures/real/{stem}.pyannote.json"))["turns"]
spans = json.load(open(reference_path))["spans"]

judged = 0
impure = 0
impure_seconds = 0.0
judged_seconds = 0.0
worst = []
for turn in turns:
    lo, hi = turn["start_ms"], turn["end_ms"]
    per_person: dict[str, float] = {}
    for span in spans:
        overlap = min(hi, span["end_ms"]) - max(lo, span["start_ms"])
        if overlap > 0:
            per_person[span["speaker"]] = per_person.get(span["speaker"], 0) + overlap / 1000
    labelled = sum(per_person.values())
    if labelled < MIN_LABELLED:
        continue
    judged += 1
    judged_seconds += labelled
    minor = labelled - max(per_person.values())
    if len(per_person) > 1 and minor >= 0.2:
        impure += 1
        impure_seconds += minor
        worst.append((minor, lo / 1000, hi / 1000, dict(sorted(per_person.items()))))

print(f"{stem}: {len(turns)} turns, {judged} with >= {MIN_LABELLED}s of reference speech")
print(
    f"  {impure} of those ({100 * impure / max(judged, 1):.0f}%) contain two labelled people; "
    f"{impure_seconds:.0f}s of the {judged_seconds:.0f}s judged is on the wrong side of a "
    f"missing boundary ({100 * impure_seconds / max(judged_seconds, 1e-9):.1f}%)"
)
for minor, lo, hi, people in sorted(worst, reverse=True)[:10]:
    detail = " ".join(f"{name} {secs:.1f}s" for name, secs in people.items())
    print(f"   {lo:8.2f}-{hi:8.2f}  minority {minor:5.2f}s   {detail}")
