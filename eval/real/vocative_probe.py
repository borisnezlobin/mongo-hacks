"""Held-out structural check: can a vocative ever name anybody on this recording?

jerry-45min has no reference spans and no landmarks, so there is no accuracy to
report on it. There is still one thing worth measuring, and it is the thing that
is actually broken there: "Jerry" is addressed sixteen times and never
identified.

A vocative names somebody who is therefore NOT the speaker. For that to become a
name, the person addressed has to reply and the reply has to land on a DIFFERENT
label from the address. If both sit on one label, no naming rule can fire, no
matter how good it is -- the evidence has been destroyed upstream. So the
measurable question is: how often is the sentence after a vocative on a
different label from the vocative itself?

Reported for the shipping diarization, for the same audio re-cut on whisper's
sentence boundaries keeping the diarizer's own labels, and for pooled matching
on those sentences. No tuning happens here and no threshold is chosen from it;
it is read once, last.

  sidecar/.venv/bin/python eval/real/vocative_probe.py jerry-45min Jerry
"""

import json
import os
import re
import sys

import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from embedders import load  # noqa: E402
from pooled_turns import embed_spans  # noqa: E402

stem = sys.argv[1]
name = sys.argv[2] if len(sys.argv) > 2 else "Jerry"
POOL_MIN_S = float(os.environ.get("POOL_MIN_S", 4.0))
checkpoint = os.environ.get("SPK_MODEL", "pyannote/wespeaker-voxceleb-resnet34-LM")

turns = json.load(open(f"fixtures/real/{stem}.pyannote.json"))["turns"]
whisper = json.load(open(f"fixtures/real/{stem}.whisper.json"))
def sentences_from(payload):
    """Sentence spans, from whisper's own segments when it gave any.

    jerry-45min's transcript has words and no segments, so the fallback splits
    on terminal punctuation. That is not a lesser input -- it is what the live
    product has, since the streaming path accumulates words -- but it is a
    different segmenter from the one dorm-40min was measured with, and the two
    must not be quietly compared as if they were the same.
    """
    if payload.get("segments"):
        return [s for s in payload["segments"] if s["end"] > s["start"]], "whisper segments"
    # jerry-45min's word list has the punctuation stripped, while the full
    # `text` keeps it. Walking the two in step recovers which word each sentence
    # ends on without inventing boundaries from pauses -- a pause split would be
    # a third segmenter and would confound the comparison it is here to make.
    text = payload.get("text", "")
    cursor = 0
    out, current = [], []
    for word in payload["words"]:
        token = word["word"].strip()
        current.append(word)
        found = text.find(token, cursor)
        if found < 0:
            continue
        cursor = found + len(token)
        trailing = text[cursor : cursor + 2]
        if trailing[:1] in {".", "?", "!"}:
            out.append(current)
            current = []
    if current:
        out.append(current)
    return [
        {"start": group[0]["start"], "end": group[-1]["end"],
         "text": " ".join(w["word"] for w in group)}
        for group in out
        if group[-1]["end"] > group[0]["start"]
    ], "punctuation over words"


sentences, segmenter = sentences_from(whisper)

def label_at(start_ms, end_ms):
    best, most = "", 0
    for turn in turns:
        shared = min(end_ms, turn["end_ms"]) - max(start_ms, turn["start_ms"])
        if shared > most:
            best, most = turn["speaker"], shared
    return best

for sentence in sentences:
    sentence["start_ms"] = int(sentence["start"] * 1000)
    sentence["end_ms"] = int(sentence["end"] * 1000)
    sentence["inherited"] = label_at(sentence["start_ms"], sentence["end_ms"])

audio, sr = sf.read(f"fixtures/real/{stem}.wav", dtype="float32")
cache = f"eval/real/{stem}.vocative.npz"
key = f"{checkpoint}|{len(turns)}|{len(sentences)}"
if os.path.exists(cache) and str(np.load(cache, allow_pickle=True)["key"]) == key:
    blob = np.load(cache, allow_pickle=True)
    pool_vectors, query_vectors = blob["pool"], blob["query"]
else:
    embed_batch = load(checkpoint)
    pool_vectors = embed_spans(
        audio, sr, [(t["start_ms"] / 1000, t["end_ms"] / 1000) for t in turns], embed_batch
    )
    query_vectors = embed_spans(
        audio, sr, [(s["start"], s["end"]) for s in sentences], embed_batch
    )
    np.savez_compressed(cache, pool=pool_vectors, query=query_vectors, key=key)

members = {}
for index, turn in enumerate(turns):
    if (turn["end_ms"] - turn["start_ms"]) / 1000 >= POOL_MIN_S:
        members.setdefault(turn["speaker"], []).append(index)
names = sorted(members)
centroids = np.vstack(
    [
        pool_vectors[members[n]].mean(axis=0) / np.linalg.norm(pool_vectors[members[n]].mean(axis=0))
        for n in names
    ]
)
for index, sentence in enumerate(sentences):
    distances = 1 - centroids @ query_vectors[index]
    order = np.argsort(distances)
    sentence["pooled"] = names[order[0]]
    sentence["margin"] = float(distances[order[1]] - distances[order[0]])

pattern = re.compile(rf"\b{re.escape(name)}\b", re.IGNORECASE)
hits = [index for index, s in enumerate(sentences) if pattern.search(s["text"])]
print(
    f"{stem}: {len(turns)} turns on {len({t['speaker'] for t in turns})} labels, "
    f"{len(sentences)} sentences ({segmenter}), {len(names)} pools >= {POOL_MIN_S}s; "
    f"'{name}' appears in {len(hits)} sentences"
)

for scheme in ["shipping", "control", "pooled"]:
    separated = 0
    counted = 0
    for index in hits:
        if index + 1 >= len(sentences):
            continue
        here, after = sentences[index], sentences[index + 1]
        if after["start"] - here["end"] > 5.0:
            continue
        counted += 1
        if scheme == "shipping":
            same = label_at(here["start_ms"], here["end_ms"]) == label_at(
                after["start_ms"], after["end_ms"]
            )
        elif scheme == "control":
            same = here["inherited"] == after["inherited"]
        else:
            same = here["pooled"] == after["pooled"]
        separated += not same
    print(
        f"  {scheme:9s}: the reply is on a different label in {separated}/{counted} "
        f"of the addresses that have one within 5s"
    )

print(f"\nevery '{name}' sentence and what follows it:")
for index in hits:
    here = sentences[index]
    after = sentences[index + 1] if index + 1 < len(sentences) else None
    print(
        f"  {here['start']:8.2f}  {here['inherited'] or '-':11s} pooled {here['pooled']:11s} "
        f"m={here['margin']:.3f}  {here['text'].strip()[:52]}"
    )
    if after is not None and after["start"] - here["end"] <= 5.0:
        print(
            f"  {after['start']:8.2f}  {after['inherited'] or '-':11s} pooled {after['pooled']:11s} "
            f"m={after['margin']:.3f}    -> {after['text'].strip()[:48]}"
        )
