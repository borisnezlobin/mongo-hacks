"""Attribute whisper SENTENCES by pooled-centroid similarity, not by overlap.

Two results that were established separately and never combined:

  A whisper sentence is about four times purer than a pyannote turn (5.9%
  against 25.1% impure on dorm-40min), so it is the better unit to attribute.

  Matching a clip against a POOLED model of a voice beats any per-turn
  comparison, and the noise ablation in sortformer_pooled.py showed the pooled
  vectors really do carry the grouping rather than riding on a constraint.

Sentence-level attribution has been tried once here and was reverted. It settled
each sentence by max overlap - whichever diarization turn the sentence sat
inside most - which throws away the long-turn protection in
`speakerForSpan` and moved landmark errors onto labels nothing watches rather
than fixing them. The unit was right and the matcher was wrong. This uses the
same unit with the pooled matcher instead.

The pools are built from the diarization's own confident stretches: long turns
that no other label overlaps. That is the honest version - it uses only what the
shipped pipeline already produces - and it is also the weak point, because pools
built from our own diarization inherit its errors.

PASS --embedder speechbrain/spkrec-ecapa-voxceleb. The default in embedders.py
is wespeaker, but sidecar/app.py loads ECAPA, and the difference is larger than
anything in this sweep: with wespeaker the same constants leave landmark merges
on dorm-40min that ECAPA removes. Measuring the eval's default rather than the
shipped model is the easiest way to draw the wrong conclusion here.

  python eval/real/sentence_pooled.py <stem> [--budgets 20,60] [--stretch 2,4]

Writes eval/real/<stem>.sentpool-b<budget>-s<stretch>.json in the fixture turn
shape. Real-people data: reads gitignored fixtures, writes only to eval/real/.
"""

import argparse
import json
import os
import sys
import warnings

warnings.filterwarnings("ignore")

import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from whisper_sentences import sentences_of  # noqa: E402

SAMPLE_RATE = 16000
# Below this a clip embeds to noise rather than to a voice.
EMBED_FLOOR = 0.30


def load_turns(path: str) -> list[dict]:
    payload = json.load(open(path))
    rows = payload.get("turns") or payload["segments"]
    if "start_ms" in rows[0]:
        return [{"start": r["start_ms"] / 1000, "end": r["end_ms"] / 1000,
                 "speaker": str(r["speaker"])} for r in rows]
    return [{"start": r["start"], "end": r["end"], "speaker": str(r["speaker"])} for r in rows]


def confident_stretches(turns: list[dict], min_stretch: float) -> dict[str, list[tuple]]:
    """Long turns that no other label overlaps, longest first.

    A stretch another speaker talks over is a stretch whose voice is a blend, and
    a pool built from blends describes nobody. Length is the second filter: the
    point of a pool is that it averages away what a single short clip gets wrong.
    """
    clean: dict[str, list[tuple]] = {}
    for turn in turns:
        if turn["end"] - turn["start"] < min_stretch:
            continue
        if any(other is not turn and other["speaker"] != turn["speaker"]
               and other["start"] < turn["end"] and turn["start"] < other["end"]
               for other in turns):
            continue
        clean.setdefault(turn["speaker"], []).append((turn["start"], turn["end"]))
    for speaker in clean:
        clean[speaker].sort(key=lambda span: span[0] - span[1])
    return clean


def base_label(turns: list[dict], start: float, end: float) -> str | None:
    """The diarizer's own answer for a span, by best FIT rather than most overlap.

    Fit is the share of the TURN the span covers, which is what
    `server/audio/word-join.ts` uses and for the reason given there: a long turn
    contains a short span completely, so raw overlap hands every short utterance
    to whoever was talking longest around it.
    """
    best, best_fit = None, 0.0
    for turn in turns:
        held = min(end, turn["end"]) - max(start, turn["start"])
        if held <= 0:
            continue
        fit = held / max(turn["end"] - turn["start"], 1e-9)
        if fit > best_fit:
            best, best_fit = turn["speaker"], fit
    return best


def uncovered(turns: list[dict], covered: list[tuple]) -> list[dict]:
    """Diarizer turns clipped to the time no sentence speaks for.

    Whisper does not transcribe everything - backchannels, crosstalk and unclear
    speech go missing - and that speech has a label today. Keeping the diarizer's
    answer wherever no sentence exists makes this pass strictly additive instead
    of trading coverage for accuracy.
    """
    merged: list[list[float]] = []
    for start, end in sorted(covered):
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    out = []
    for turn in turns:
        pieces = [(turn["start"], turn["end"])]
        for lo, hi in merged:
            nxt = []
            for a, b in pieces:
                if hi <= a or lo >= b:
                    nxt.append((a, b))
                    continue
                if lo > a:
                    nxt.append((a, min(lo, b)))
                if hi < b:
                    nxt.append((max(hi, a), b))
            pieces = nxt
        out.extend({"start": a, "end": b, "speaker": turn["speaker"]}
                   for a, b in pieces if b - a > 0.05)
    return out


def take(audio: np.ndarray, spans: list[tuple], budget: float) -> np.ndarray:
    pieces, total = [], 0.0
    for start, end in spans:
        if total >= budget:
            break
        end = min(end, start + (budget - total))
        pieces.append(audio[int(start * SAMPLE_RATE):int(end * SAMPLE_RATE)])
        total += end - start
    return np.concatenate(pieces) if pieces else np.zeros(0, dtype=np.float32)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("stem")
    parser.add_argument("--diarization", default=None)
    parser.add_argument("--budgets", default="10,20,40,80")
    parser.add_argument("--stretches", default="1.5,3.0")
    parser.add_argument("--embedder", default="pyannote/wespeaker-voxceleb-resnet34-LM")
    # Sentences shorter than this are DEFERRED, not guessed: no sentence-level
    # turn is emitted and the diarizer's own turns cover that time at their own
    # resolution. That matters beyond confidence - whisper sometimes puts two
    # speakers in one short sentence ("Goodnight, Clara." is 0.76 s and holds
    # both a vocative and the reply to it), and a sentence-level turn there
    # forces them onto one label no matter who assigns it.
    parser.add_argument("--defer-under", type=float, default=0.0)
    args = parser.parse_args()

    turns = load_turns(args.diarization or f"fixtures/real/{args.stem}.pyannote.json")
    sentences = sentences_of(args.stem)
    audio, sample_rate = sf.read(f"fixtures/real/{args.stem}.wav", dtype="float32")
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    assert sample_rate == SAMPLE_RATE, sample_rate

    from embedders import load
    embed = load(args.embedder)

    # Sentence vectors do not depend on the pool settings, so they are computed
    # once and the sweep only rebuilds the models.
    floor = max(EMBED_FLOOR, args.defer_under)
    usable = [s for s in sentences if s["end"] - s["start"] >= floor]
    vectors = []
    for sentence in usable:
        clip = audio[int(sentence["start"] * SAMPLE_RATE):int(sentence["end"] * SAMPLE_RATE)]
        vector = np.asarray(embed(clip[None, :].astype(np.float32))[0], dtype=np.float64).ravel()
        vectors.append(vector / (np.linalg.norm(vector) + 1e-9))
    vectors = np.array(vectors)
    print(f"{args.stem}: {len(usable)} sentences of {len(sentences)} at least {EMBED_FLOOR:g}s, "
          f"median {np.median([s['end'] - s['start'] for s in usable]):.2f}s")

    for stretch in [float(x) for x in args.stretches.split(",")]:
        stretches = confident_stretches(turns, stretch)
        for budget in [float(x) for x in args.budgets.split(",")]:
            names, centroids, pooled = [], [], []
            for speaker, spans in sorted(stretches.items()):
                clip = take(audio, spans, budget)
                seconds = len(clip) / SAMPLE_RATE
                if seconds < min(budget, 2.0):
                    continue
                vector = np.asarray(embed(clip[None, :].astype(np.float32))[0],
                                    dtype=np.float64).ravel()
                names.append(speaker)
                centroids.append(vector / (np.linalg.norm(vector) + 1e-9))
                pooled.append(seconds)
            if len(names) < 2:
                print(f"  stretch {stretch:g}s budget {budget:g}s: only {len(names)} pools")
                continue
            scores = vectors @ np.array(centroids).T
            chosen = scores.argmax(axis=1)

            out = [{"start_ms": int(sentence["start"] * 1000),
                    "end_ms": int(sentence["end"] * 1000),
                    "speaker": names[pick]}
                   for sentence, pick in zip(usable, chosen)]
            # A sentence too short to embed keeps the diarizer's answer rather
            # than losing its speaker, and speech no sentence covers keeps the
            # diarizer's turns. Both make this pass add information only.
            for gap in uncovered(turns, [(s["start"], s["end"]) for s in usable]):
                out.append({"start_ms": int(gap["start"] * 1000),
                            "end_ms": int(gap["end"] * 1000),
                            "speaker": gap["speaker"]})
            out.sort(key=lambda t: (t["start_ms"], t["end_ms"]))
            coalesced: list[dict] = []
            for turn in out:
                last = coalesced[-1] if coalesced else None
                if (last and last["speaker"] == turn["speaker"]
                        and turn["start_ms"] <= last["end_ms"]):
                    last["end_ms"] = max(last["end_ms"], turn["end_ms"])
                else:
                    coalesced.append(dict(turn))
            out = coalesced
            path = (f"eval/real/{args.stem}.sentpool"
                    f"-b{budget:g}-s{stretch:g}-d{args.defer_under:g}.json")
            json.dump({"turns": out}, open(path, "w"))

            held = {name: 0.0 for name in names}
            for sentence, pick in zip(usable, chosen):
                held[names[pick]] += sentence["end"] - sentence["start"]
            total = sum(held.values()) or 1e-9
            print(f"  stretch {stretch:g}s budget {budget:g}s: {len(names)} pools "
                  f"(mean {np.mean(pooled):.0f}s), top label {100 * max(held.values()) / total:.0f}% "
                  f"-> {path}")
