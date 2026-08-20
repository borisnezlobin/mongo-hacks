"""Can a whisper sentence be a unit of attribution at all?

word-join.ts opens by refusing to be one: "a whisper segment routinely spans a
speaker change, so attributing whole segments hands one person the other's
words, which is the single most expensive mistake this system can make."
`smoothSpeakers` then uses sentences only as a NEIGHBOURHOOD and never as a
unit, and abstains wherever the sentence's own clean words disagree.

A re-segmentation experiment that gives each sentence one label is exactly the
forbidden thing, and it measured BETTER on dorm-40min. One of the two has to be
wrong, and the way to find out is not to argue about it. `turn_purity.py`
already counts how much speech sits inside a pyannote turn holding two people;
this counts the same thing for whisper sentences, so the two units can be
compared on the one question that decides which may carry a label.

  sidecar/.venv/bin/python eval/real/sentence_purity.py dorm-40min
"""

import json
import sys

MIN_LABELLED = 0.5

stem = sys.argv[1]
whisper = json.load(open(f"fixtures/real/{stem}.whisper.json"))
spans = json.load(open(f"eval/real/{stem}.reference.json"))["spans"]
turns = json.load(open(f"fixtures/real/{stem}.pyannote.json"))["turns"]

sentences = [
    {"start_ms": int(s["start"] * 1000), "end_ms": int(s["end"] * 1000), "text": s["text"].strip()}
    for s in whisper["segments"]
    if s["end"] > s["start"]
]


def report(name, units):
    judged = impure = 0
    judged_seconds = impure_seconds = 0.0
    worst = []
    for unit in units:
        lo, hi = unit["start_ms"], unit["end_ms"]
        per = {}
        for span in spans:
            shared = min(hi, span["end_ms"]) - max(lo, span["start_ms"])
            if shared > 0:
                per[span["speaker"]] = per.get(span["speaker"], 0) + shared / 1000
        labelled = sum(per.values())
        if labelled < MIN_LABELLED:
            continue
        judged += 1
        judged_seconds += labelled
        minor = labelled - max(per.values())
        if len(per) > 1 and minor >= 0.2:
            impure += 1
            impure_seconds += minor
            worst.append((minor, lo / 1000, hi / 1000, unit.get("text", ""), dict(sorted(per.items()))))
    print(
        f"  {name:22s} {len(units):5d} units, {judged:4d} judged, "
        f"{impure:4d} impure ({100 * impure / max(judged, 1):4.1f}%), "
        f"{impure_seconds:6.1f}s of {judged_seconds:7.1f}s on the wrong side of a "
        f"missing boundary ({100 * impure_seconds / max(judged_seconds, 1e-9):4.1f}%)"
    )
    return worst


print(f"{stem}: how much speech a single label would misattribute, by unit")
worst_turns = report("pyannote turns", turns)
worst_sentences = report("whisper sentences", sentences)

print("\nthe worst whisper sentences to hand to one speaker:")
for minor, lo, hi, text, people in sorted(worst_sentences, reverse=True)[:8]:
    detail = " ".join(f"{n} {s:.1f}s" for n, s in people.items())
    print(f"  {lo:8.2f}-{hi:8.2f}  minority {minor:5.2f}s  {detail:34s} | {text[:44]}")
