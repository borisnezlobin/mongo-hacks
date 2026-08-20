"""Does one diarization label contain both a question and its answer?

mentra-mtg has no reference spans, so DER cannot say whether its 68% label is
one talkative person or several people merged. This asks a question the
transcript can answer on its own, the same way eval/landmarks.ts does: a label
holding a question and, a moment later, the reply to that question is a label
holding two people. No threshold and no voiceprint is involved.

The count only means something next to a control, so run it on dorm-9pm and
dorm-40min too, where the reference says how much merging is really there.

  python eval/real/dialogue_probe.py <stem> [hypothesis.json]
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from whisper_sentences import sentences_of  # noqa: E402

stem = sys.argv[1]
hypothesis_path = sys.argv[2] if len(sys.argv) > 2 else f"fixtures/real/{stem}.pyannote.json"

payload = json.load(open(hypothesis_path))
rows = payload.get("turns") or payload["segments"]
if "start_ms" in rows[0]:
    turns = [(r["start_ms"] / 1000, r["end_ms"] / 1000, str(r["speaker"])) for r in rows]
else:
    turns = [(r["start"], r["end"], str(r["speaker"])) for r in rows]

sentences = sentences_of(stem)


def label_of(start: float, end: float) -> str | None:
    """The label holding most of a sentence."""
    best, best_overlap = None, 0.0
    for turn_start, turn_end, speaker in turns:
        overlap = min(end, turn_end) - max(start, turn_start)
        if overlap > best_overlap:
            best, best_overlap = speaker, overlap
    return best if best_overlap > 0.2 * max(end - start, 1e-9) else None


for sentence in sentences:
    sentence["label"] = label_of(sentence["start"], sentence["end"])

MAX_GAP = 2.0
pairs: dict[str, int] = {}
examples: dict[str, list] = {}
questions: dict[str, int] = {}
asked = 0
same_label = 0
for earlier, later in zip(sentences, sentences[1:]):
    if not earlier["label"] or not later["label"]:
        continue
    if not earlier["text"].endswith("?"):
        continue
    if later["start"] - earlier["end"] > MAX_GAP:
        continue
    # A question answered by its own asker usually keeps going; a genuine
    # answer is a separate sentence that does not itself ask something.
    if later["text"].endswith("?"):
        continue
    asked += 1
    if earlier["label"] != later["label"]:
        continue
    same_label += 1
    questions[earlier["label"]] = questions.get(earlier["label"], 0) + 1
    pairs[earlier["label"]] = pairs.get(earlier["label"], 0) + 1
    examples.setdefault(earlier["label"], []).append(
        (earlier["start"], earlier["text"][:60], later["text"][:60])
    )

seconds: dict[str, float] = {}
for turn_start, turn_end, speaker in turns:
    seconds[speaker] = seconds.get(speaker, 0.0) + (turn_end - turn_start)

print(f"{stem}  <- {hypothesis_path}   {len(sentences)} whisper sentences")
print(f"  {same_label} of {asked} question-and-answer adjacencies "
      f"({100 * same_label / max(asked, 1):.0f}%) stay on one label - each is a label "
      f"holding both sides of an exchange")
print(f"{'label':14} {'seconds':>8} {'share':>6} {'questions':>10} {'answered in-label':>18}")
total = sum(seconds.values()) or 1e-9
for speaker in sorted(seconds, key=lambda s: -seconds[s]):
    print(f"{speaker:14} {seconds[speaker]:8.1f} {100 * seconds[speaker] / total:5.0f}% "
          f"{questions.get(speaker, 0):10d} {pairs.get(speaker, 0):18d}")
biggest = max(seconds, key=lambda s: seconds[s])
print(f"\nfirst question-and-answer pairs inside {biggest}, the dominant label:")
for at, question, answer in examples.get(biggest, [])[:8]:
    print(f"  {at:8.1f}s  Q {question!r}\n            A {answer!r}")
