"""Trim a diarization to where whisper actually heard words.

Sortformer's speaker attribution is the best measured here, but its DER is
dragged down by voice activity rather than by attribution: on dorm-40min the
windowed system runs 2.1% missed detection against 21.8% false alarm. False
alarm is speech claimed where there is none, and this repository already holds a
second, independent opinion about where speech is - whisper's word timings,
produced by a model that never saw the diarization.

So this keeps the speaker labels exactly as they are and only removes the parts
that no transcribed word covers. It cannot fix attribution and is not meant to;
it says how much of the error was never about attribution.

  python eval/real/whisper_mask.py <stem> <diarization.json> [pad_seconds]

Writes alongside the input with a .masked.json suffix.
"""

import json
import sys

stem, path = sys.argv[1], sys.argv[2]
pad = float(sys.argv[3]) if len(sys.argv) > 3 else 0.2

whisper = json.load(open(f"fixtures/real/{stem}.whisper.json"))
words = whisper.get("words") or [
    word for segment in whisper.get("segments", []) for word in segment.get("words", [])
]
if not words:
    raise SystemExit(f"{stem}.whisper.json carries no word timings to mask with")

# One merged speech timeline, padded, so a label is trimmed rather than
# fragmented by the gaps between individual words.
spans = []
for word in sorted(words, key=lambda w: w["start"]):
    start, end = word["start"] - pad, word["end"] + pad
    if spans and start <= spans[-1][1]:
        spans[-1][1] = max(spans[-1][1], end)
    else:
        spans.append([start, end])

payload = json.load(open(path))
rows = payload.get("turns") or payload["segments"]
milliseconds = "start_ms" in rows[0]

kept, dropped_seconds, total_seconds = [], 0.0, 0.0
cursor = 0
for row in rows:
    start = row["start_ms"] / 1000 if milliseconds else row["start"]
    end = row["end_ms"] / 1000 if milliseconds else row["end"]
    total_seconds += end - start
    while cursor > 0 and spans[cursor][1] > start:
        cursor -= 1
    while cursor < len(spans) and spans[cursor][1] <= start:
        cursor += 1
    covered = 0.0
    for span_start, span_end in spans[cursor:]:
        if span_start >= end:
            break
        piece_start, piece_end = max(start, span_start), min(end, span_end)
        if piece_end > piece_start:
            covered += piece_end - piece_start
            kept.append({"start_ms": int(piece_start * 1000), "end_ms": int(piece_end * 1000),
                         "speaker": str(row["speaker"])})
    dropped_seconds += (end - start) - covered

kept.sort(key=lambda t: (t["start_ms"], t["end_ms"]))
out = path.replace(".json", ".masked.json")
json.dump({"turns": kept}, open(out, "w"))
print(f"{path} -> {out}: kept {len(kept)} of {len(rows)} turns, "
      f"dropped {dropped_seconds:.0f}s of {total_seconds:.0f}s "
      f"({100 * dropped_seconds / max(total_seconds, 1e-9):.0f}%) as speech whisper never heard")
