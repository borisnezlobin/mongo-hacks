"""Who the dorm-40min reference cannot see, how much they say, and when.

eval/real/ground-truth.json separates two things that are easy to conflate:
people it NAMED and people it SCORED. Five are named; three are scored. Vova
and Dhruv are named -- the landmark set pins lines to both of them -- and have
no scored spans at all, so DER is blind to every error involving either, and the
only instrument that can see them is four landmark lines.

Ten further clusters are unnamed. This prints their size and their span on the
timeline, which is enough to know what we are blind to. It deliberately does not
guess who they are: inferred ground truth is what produced the confidence that
had to be walked back.

  sidecar/.venv/bin/python eval/real/blind-people.py
"""

import json
from collections import defaultdict

truth = json.load(open("eval/real/ground-truth.json"))
scored = {span["speaker"] for span in truth["spans"]}

# Every excluded stretch carries the chunk-local label it came from, and each
# person lists the labels that were pooled into them, so the two join up.
where = defaultdict(list)
for entry in truth["excluded"]:
    where[entry.get("label")].append((entry["start_ms"], entry["end_ms"]))
for span in truth["spans"]:
    where[span.get("label")].append((span["start_ms"], span["end_ms"]))

print(f"{truth['recording']}: {truth['true_people']} people in the room, "
      f"{len(truth['people'])} clusters found, {len(scored)} of them scored")
print(f"  scored speech {truth['coverage']['scored_speech_s']:.0f}s of "
      f"{truth['coverage']['diarized_speech_s']:.0f}s diarized "
      f"({100 * truth['coverage']['scored_fraction_of_speech']:.0f}%)\n")

header = f"  {'cluster':12s} {'name':7s} {'confidence':14s} {'seconds':>8s}  {'first':>7s} {'last':>7s}  scored"
print(header)
invisible = 0.0
for person in truth["people"]:
    stretches = [s for label in person["labels"] for s in where.get(label, [])]
    first = min((s for s, _ in stretches), default=0) / 1000
    last = max((e for _, e in stretches), default=0) / 1000
    is_scored = person["id"] in scored
    if not is_scored:
        invisible += person["seconds"]
    print(
        f"  {person['id']:12s} {(person['name'] or '-'):7s} {person['confidence']:14s} "
        f"{person['seconds']:7.1f}s  {first:6.0f}s {last:6.0f}s  {'yes' if is_scored else 'NO'}"
    )

total = sum(person["seconds"] for person in truth["people"])
print(
    f"\n  {invisible:.0f}s of {total:.0f}s pooled speech belongs to a cluster with no scored "
    f"span ({100 * invisible / total:.0f}%). Any change that moves speech among these "
    f"costs nothing and earns nothing in DER."
)

named_unscored = [p for p in truth["people"] if p["name"] and p["id"] not in scored]
if named_unscored:
    print(
        "\n  named but never scored: "
        + ", ".join(f"{p['name']} ({p['seconds']:.0f}s)" for p in named_unscored)
        + " -- the landmarks constrain these people, the rates cannot."
    )

print("\n  why each cluster was withheld:")
counts = defaultdict(float)
for entry in truth["excluded"]:
    counts[entry.get("reason", "?")] += (entry["end_ms"] - entry["start_ms"]) / 1000
for reason, seconds in sorted(counts.items(), key=lambda kv: -kv[1]):
    print(f"    {reason:24s} {seconds:7.0f}s")

if truth.get("to_resolve"):
    print(f"\n  {len(truth['to_resolve'])} cases the builder recorded as resolvable by listening:")
    for item in truth["to_resolve"][:6]:
        print(f"    {item}")
