"""What a floor on DECLARING SOMEBODY NEW would cost, in people and in minutes.

Identity mints a person when a cluster clears CONFIRMED_SPEECH_MS and matches
nobody (server/identity/service.ts, applyDecision). Cross-recording, at 20s of
pooled speech, a third of genuine links score under the threshold -- so a third
of returning people are minted as strangers instead. Raising the mint floor
fixes that only if people actually reach the higher floor, and reach it soon
enough to be useful. This measures both, on the real recordings.

For every diarization cluster it reports when the cluster's POOLED exclusive
speech crosses each candidate floor -- which is the quantity the gate reads --
and what share of speech and of turns belongs to clusters that never cross it.

  python eval/real/floor_cost.py
  FLOORS=8,20,60,120  seconds of pooled speech to test

Reads gitignored fixtures. Prints no transcript text.
"""

import json
import os
from collections import defaultdict

FLOORS = [float(x) for x in os.environ.get("FLOORS", "8,20,60,120").split(",")]
STEMS = ["dorm-9pm", "dorm-40min", "jerry-45min", "mentra-mtg"]
# Cluster -> person where an independent label exists; see cross-session-identity.mts.
KNOWN = {
    "dorm-9pm/SPEAKER_01": "joshua", "dorm-9pm/SPEAKER_02": "boris", "dorm-9pm/SPEAKER_03": "tarun",
    "dorm-40min/SPEAKER_04": "boris", "dorm-40min/SPEAKER_06": "tarun",
    "jerry-45min/SPEAKER_03": "tarun", "jerry-45min/SPEAKER_04": "boris",
    "mentra-mtg/SPEAKER_00": "alex", "mentra-mtg/SPEAKER_02": "boris", "mentra-mtg/SPEAKER_03": "brendan",
}


def exclusive_ms(turns):
    """Per cluster, (turn_end_ms, cumulative exclusive ms) -- what the gate reads."""
    events = defaultdict(list)
    running = defaultdict(float)
    for turn in sorted(turns, key=lambda t: t["start_ms"]):
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
        running[turn["speaker"]] += sum(hi - lo for lo, hi in pieces)
        events[turn["speaker"]].append((turn["end_ms"], running[turn["speaker"]]))
    return events


totals = defaultdict(lambda: {"clusters": 0, "cleared": defaultdict(int), "speech": 0.0, "cleared_speech": defaultdict(float)})
print(f"floors tested: {', '.join(f'{f:g}s' for f in FLOORS)}\n")
for stem in STEMS:
    turns = json.load(open(f"fixtures/real/{stem}.pyannote.json"))["turns"]
    events = exclusive_ms(turns)
    length_ms = max(t["end_ms"] for t in turns)
    counts = defaultdict(int)
    for turn in turns:
        counts[turn["speaker"]] += 1
    print(f"{stem}  ({length_ms / 60000:.0f} min, {len(events)} clusters)")
    print(f"  {'cluster':12s} {'who':9s} {'speech':>8s} {'turns':>6s}  " + "  ".join(f"{f:g}s at".rjust(9) for f in FLOORS))
    for speaker in sorted(events, key=lambda s: -events[s][-1][1]):
        pooled = events[speaker][-1][1]
        who = KNOWN.get(f"{stem}/{speaker}", "-")
        cells = []
        for floor in FLOORS:
            hit = next((at for at, total in events[speaker] if total >= floor * 1000), None)
            cells.append(f"{hit / 60000:6.1f}min" if hit is not None else "  never ")
            totals[floor]["x"] = None
        print(f"  {speaker:12s} {who:9s} {pooled / 1000:7.0f}s {counts[speaker]:6d}  " + "  ".join(c.rjust(9) for c in cells))
    for floor in FLOORS:
        totals[floor]["clusters"] += len(events)
        for speaker in events:
            pooled = events[speaker][-1][1]
            totals[floor]["speech"] += pooled
            if pooled >= floor * 1000:
                totals[floor]["cleared"][0] += 1
                totals[floor]["cleared_speech"][0] += pooled
    print()

print("across all four recordings")
print(f"  {'floor':>6s}  {'clusters clearing it':>22s}  {'share of pooled speech':>24s}")
for floor in FLOORS:
    row = totals[floor]
    clusters = row["clusters"] / len(FLOORS) if False else row["clusters"]
    cleared = row["cleared"][0]
    speech = row["speech"]
    print(f"  {floor:5g}s  {cleared:3d} of {clusters:3d}  ({100 * cleared / clusters:4.0f}%)      "
          f"{100 * row['cleared_speech'][0] / speech:5.1f}% of speech")

print("\nknown people only (the ones a duplicate would actually split)")
for floor in FLOORS:
    cleared = 0
    total = 0
    for stem in STEMS:
        turns = json.load(open(f"fixtures/real/{stem}.pyannote.json"))["turns"]
        events = exclusive_ms(turns)
        for speaker in events:
            if f"{stem}/{speaker}" not in KNOWN:
                continue
            total += 1
            if events[speaker][-1][1] >= floor * 1000:
                cleared += 1
    print(f"  {floor:5g}s  {cleared} of {total} labelled clusters clear it")
