"""Whisper's sentences, with timings, whichever shape the transcript is in.

Two transcript shapes exist in fixtures/real/: some carry `segments` with text
and timings already grouped, others carry only per-word timings with the
punctuation living in a separate `text` field. They are the same token sequence
in the same order, so the second can be walked alongside the first to recover
sentence boundaries with timings attached.

The unit matters. Measured by eval/real/sentence_purity.py, a whisper sentence
is about four times purer than a pyannote turn - 5.9% against 25.1% impure on
dorm-40min, 15.5% against 45.8% on dorm-9pm - so it is the better thing to
attribute, provided it is attributed by something better than max overlap.
"""

import json


def sentences_of(stem: str) -> list[dict]:
    whisper = json.load(open(f"fixtures/real/{stem}.whisper.json"))
    if "segments" in whisper:
        return [{"start": segment["start"], "end": segment["end"],
                 "text": segment["text"].strip()}
                for segment in whisper["segments"] if segment["text"].strip()]

    words = whisper["words"]
    rows, current, start, cursor = [], [], None, 0
    for token in whisper["text"].split():
        if cursor >= len(words):
            break
        if start is None:
            start = words[cursor]["start"]
        current.append(token)
        end = words[cursor]["end"]
        cursor += 1
        if token.endswith((".", "?", "!")):
            rows.append({"start": start, "end": end, "text": " ".join(current)})
            current, start = [], None
    if current and start is not None:
        rows.append({"start": start, "end": words[cursor - 1]["end"],
                     "text": " ".join(current)})
    return rows
