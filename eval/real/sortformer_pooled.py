"""Sortformer for local speaker separation, pooled centroids for who they are.

Two measured facts point at each other. Sortformer has the best speaker
discrimination of anything tried here - on dorm-9pm it reaches 13.4% confusion
against pyannote 3.1's 25.0%, at 79.0% label purity - and its mistakes are
SPLITS, one person arriving as two labels. Assignment against a pooled voice
model is the other lane's strongest result, and merging is the one direction it
can move a label. Nothing can unmerge a person, so a system that errs by
splitting is the right input to a stage that merges.

It also answers the cap. `sortformer_modules.hidden_to_spks` is a (4, 384)
layer: four speaker channels, architecturally, in every published checkpoint. A
seven-person recording cannot be represented in one pass. But a 90-second window
of a seven-person conversation almost always holds four or fewer active
speakers, so the model is asked only for local separation, which is what it is
good at, and global identity is rebuilt across windows by the pooled stage,
which is what that is good at.

Two things measured here read backwards at first and are written down so they
are not re-derived wrongly:

  The assignment THRESHOLD does nothing. Results are identical from -1.0 to
  about 0.4, because the cannot-link constraint stops the merging before any
  threshold does. It is tempting to conclude from this that the pooled
  embeddings do not matter. They do: replacing them with noise and changing
  nothing else takes dorm-40min from 7 people to 10-11 and its landmark splits
  from 0 to 4, and takes dorm-9pm's confusion from 15.4% to 44-56%. The
  embeddings choose which local speakers group together; the constraint decides
  how many groups there can be. Only the stopping rule is inert.

  The pooled vectors are NOT near-orthogonal across windows. On dorm-40min the
  same person scores 0.488 +- 0.212 against 0.228 +- 0.131 for different people,
  AUC 0.842 (eval/real/pool_drift.py). What is true is that a threshold high
  enough to avoid false accepts keeps very little: at 0.75 the false-accept rate
  is 0.0% and only 11.3% of genuine matches survive. Precision and recall are
  being measured, and a result about one says nothing about the other.

  python eval/real/sortformer_pooled.py <stem> [--window 90 --hop 45]

Window inference is cached per geometry in
<stem>.sortformer-windows-w<window>-h<hop>.json, so sweeping the assignment
threshold costs seconds. Real-people data: reads gitignored fixtures under
fixtures/real/ and writes only into eval/real/.
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

SAMPLE_RATE = 16000


def run_windows(stem: str, window: float, hop: float, model_name: str) -> list[dict]:
    """Sortformer on overlapping windows; local labels, scoped to their window."""
    from nemo.collections.asr.models import SortformerEncLabelModel

    model = SortformerEncLabelModel.from_pretrained(model_name, map_location="cpu")
    model.eval()

    audio, sample_rate = sf.read(f"fixtures/real/{stem}.wav", dtype="float32")
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    assert sample_rate == SAMPLE_RATE, sample_rate

    rows = []
    duration = len(audio) / SAMPLE_RATE
    starts = np.arange(0.0, max(duration - window / 2, hop), hop)
    for index, start in enumerate(starts):
        clip = audio[int(start * SAMPLE_RATE):int((start + window) * SAMPLE_RATE)]
        if len(clip) < 2 * SAMPLE_RATE:
            continue
        predictions = model.diarize(
            audio=np.ascontiguousarray(clip, dtype=np.float32).reshape(1, -1),
            sample_rate=SAMPLE_RATE, batch_size=1, verbose=False,
        )
        for row in predictions[0]:
            begin, end, speaker = str(row).split()
            rows.append({
                "window": index,
                "start": start + float(begin),
                "end": start + float(end),
                "local": speaker,
            })
        print(f"  window {index + 1}/{len(starts)} at {start:.0f}s", flush=True)
    return rows


def clean_spans(rows: list[dict], window_index: int, local: str) -> list[tuple[float, float]]:
    """This local speaker's speech with every other local speaker cut out of it.

    A clip that holds two voices tells the pooled model nothing about whose
    voice the label is, which is the mistake that has cost this repository the
    most time. Overlap is removed rather than tolerated.
    """
    mine = [(r["start"], r["end"]) for r in rows
            if r["window"] == window_index and r["local"] == local]
    others = [(r["start"], r["end"]) for r in rows
              if r["window"] == window_index and r["local"] != local]
    out = []
    for start, end in mine:
        pieces = [(start, end)]
        for other_start, other_end in others:
            nxt = []
            for a, b in pieces:
                if other_end <= a or other_start >= b:
                    nxt.append((a, b))
                    continue
                if other_start > a:
                    nxt.append((a, min(other_start, b)))
                if other_end < b:
                    nxt.append((max(other_end, a), b))
            pieces = nxt
        out.extend((a, b) for a, b in pieces if b - a > 0.25)
    return sorted(out)


def pool_audio(audio: np.ndarray, spans: list[tuple[float, float]], cap: float) -> np.ndarray:
    taken, total = [], 0.0
    for start, end in spans:
        if total >= cap:
            break
        end = min(end, start + (cap - total))
        taken.append(audio[int(start * SAMPLE_RATE):int(end * SAMPLE_RATE)])
        total += end - start
    return np.concatenate(taken) if taken else np.zeros(0, dtype=np.float32)


def simultaneous(rows, keys, tolerance: float = 0.5) -> np.ndarray:
    """Which pooled speakers were audible at the same instant as which others.

    This is the only evidence that two local speakers are two people. Two slots
    in one window that merely take turns are equally consistent with one person
    the model split, which is its most common error.

    `tolerance` is the least overlap that counts, and it is not a free parameter
    to taste. At zero, a few milliseconds where two turns abut - a boundary
    artifact of window stitching, not two voices - is recorded as proof of two
    people. Measured on dorm-40min, moving it from 0 to 1 s drops the pairs
    called simultaneous from 206 to 130 and improves DER from 43.6% to 42.0%,
    with the landmark verdicts unchanged across 0.25 to 1.0; at 2 s the evidence
    thins out and merges rise from 3 to 7.
    """
    raw = {key: [(r["start"], r["end"]) for r in rows
                 if r["window"] == key[0] and r["local"] == key[1]]
           for key in keys}
    together = np.zeros((len(keys), len(keys)))
    for i, a in enumerate(keys):
        for j in range(i + 1, len(keys)):
            b = keys[j]
            if a[0] != b[0]:
                continue
            hit = any(min(a_end, b_end) - max(a_start, b_start) > tolerance
                      for a_start, a_end in raw[a] for b_start, b_end in raw[b])
            if hit:
                together[i, j] = together[j, i] = 1.0
    return together


def pooled_vectors(rows, audio, embed, min_pool, pool_cap):
    """One pooled embedding per window-local speaker, with its pooled seconds."""
    keys, vectors, seconds_out, skipped = [], [], [], 0
    for window_index in sorted({r["window"] for r in rows}):
        for local in sorted({r["local"] for r in rows if r["window"] == window_index}):
            spans = clean_spans(rows, window_index, local)
            seconds = sum(end - start for start, end in spans)
            if seconds < min_pool:
                # Too little clean speech to say who this is. Naming nobody
                # beats naming the wrong person.
                skipped += 1
                continue
            clip = pool_audio(audio, spans, pool_cap)
            vector = np.asarray(embed(clip[None, :].astype(np.float32))[0], dtype=np.float64).ravel()
            keys.append((window_index, local))
            vectors.append(vector / (np.linalg.norm(vector) + 1e-9))
            seconds_out.append(min(seconds, pool_cap))
    return keys, np.array(vectors), np.array(seconds_out), skipped


def assign(keys, vectors, seconds, threshold, simultaneity, penalty):
    """Link window-local speakers into people, offline and order-independent.

    Average-linkage agglomerative merging over pooled embeddings, stopped at
    `threshold`, so the number of people is discovered rather than supplied.

    Two local speakers audible AT THE SAME INSTANT are evidence of two people.
    Sharing a window is not the same evidence: Sortformer's characteristic error
    is splitting one person into two local slots, and inside a window that split
    looks exactly like two people who never interrupt each other.

    The evidence is applied as a PENALTY rather than a veto:

        score(A, B) = mean cosine(A, B) - penalty * simultaneous fraction(A, B)

    where the fraction is how many of the cross-group member pairs were heard at
    once. A hard veto encodes certainty the evidence does not support, and it
    compounds: one spurious pair inside a growing group forbids every later
    merge that group could make, which is what held Tarun's two labels apart
    across nine windows. A penalty can be outvoted by strong voice similarity,
    which is the only thing that should be able to overrule it.

    `penalty` of 0 removes the constraint; a large value reproduces the veto.
    """
    groups = [{index} for index in range(len(keys))]

    def score(a: set[int], b: set[int]) -> float:
        rows_a, rows_b = list(a), list(b)
        cosine = float((vectors[rows_a] @ vectors[rows_b].T).mean())
        together = float(simultaneity[np.ix_(rows_a, rows_b)].mean())
        return cosine - penalty * together

    while len(groups) > 1:
        best, best_score = None, threshold
        for i in range(len(groups)):
            for j in range(i + 1, len(groups)):
                value = score(groups[i], groups[j])
                if value > best_score:
                    best, best_score = (i, j), value
        if best is None:
            break
        i, j = best
        groups[i] |= groups[j]
        del groups[j]

    mapping: dict[tuple[int, str], int] = {}
    order = sorted(range(len(groups)), key=lambda g: -seconds[list(groups[g])].sum())
    for person, group in enumerate(order):
        for index in groups[group]:
            mapping[keys[index]] = person
    return mapping, len(groups)


def oracle_mapping(rows, keys, stem):
    """Link window-local speakers using the reference instead of embeddings.

    This is a ceiling, not a candidate. It separates two costs that a single
    DER hides: everything between this and the plain one-pass diarization is
    the price of windowing and stitching, and everything between this and the
    embedding-linked result is the price of the linking itself. Without the
    split, a bad number says only that something is wrong.
    """
    spans = json.load(open(f"eval/real/{stem}.reference.json"))["spans"]
    people = sorted({span["speaker"] for span in spans})
    mapping = {}
    for window_index, local in keys:
        mine = clean_spans(rows, window_index, local)
        held = {person: 0.0 for person in people}
        for start, end in mine:
            for span in spans:
                overlap = min(end, span["end_ms"] / 1000) - max(start, span["start_ms"] / 1000)
                if overlap > 0:
                    held[span["speaker"]] += overlap
        best = max(held, key=lambda person: held[person])
        # A local speaker the reference never labels cannot be placed by it, so
        # it gets its own person rather than being forced onto whoever is
        # alphabetically first.
        mapping[(window_index, local)] = (
            people.index(best) if held[best] > 0 else len(people) + window_index)
    return mapping, len({v for v in mapping.values()})


def to_turns(rows, mapping, hop, window) -> list[dict]:
    """Collapse overlapping windows into one timeline.

    Each instant is covered by two windows, so a frame is kept from the window
    whose centre it is nearest: the model's view of a speaker is weakest at the
    edges of its context, and this never lets an edge outvote a centre.
    """
    spans = []
    for row in rows:
        global_speaker = mapping.get((row["window"], row["local"]))
        if global_speaker is None:
            continue
        centre = row["window"] * hop + window / 2
        spans.append((row["start"], row["end"], global_speaker, centre))

    edges = sorted({value for start, end, _, _ in spans for value in (start, end)})
    turns = []
    for start, end in zip(edges, edges[1:]):
        if end - start < 0.05:
            continue
        middle = (start + end) / 2
        here = [(abs(middle - centre), speaker)
                for span_start, span_end, speaker, centre in spans
                if span_start <= middle < span_end]
        if not here:
            continue
        best_distance = min(distance for distance, _ in here)
        for speaker in {speaker for distance, speaker in here if distance == best_distance}:
            turns.append({"start_ms": int(start * 1000), "end_ms": int(end * 1000),
                          "speaker": f"person_{speaker}"})

    turns.sort(key=lambda t: (t["speaker"], t["start_ms"]))
    merged = []
    for turn in turns:
        if merged and merged[-1]["speaker"] == turn["speaker"] \
                and turn["start_ms"] - merged[-1]["end_ms"] <= 50:
            merged[-1]["end_ms"] = turn["end_ms"]
        else:
            merged.append(dict(turn))
    merged.sort(key=lambda t: (t["start_ms"], t["end_ms"]))
    return merged


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("stem")
    parser.add_argument("--window", type=float, default=90.0)
    parser.add_argument("--hop", type=float, default=45.0)
    parser.add_argument("--model", default="nvidia/diar_sortformer_4spk-v1")
    parser.add_argument("--thresholds", default="0.50,0.55,0.60,0.65,0.70,0.75")
    parser.add_argument("--min-pool", type=float, default=2.0)
    parser.add_argument("--overlap-tolerance", type=float, default=0.5)
    parser.add_argument("--penalty", type=float, default=1.0,
                        help="0 removes the constraint; large reproduces a hard veto")
    parser.add_argument("--penalties", default=None,
                        help="comma-separated penalties to sweep; embeds once for all of them")
    parser.add_argument("--pool-cap", type=float, default=20.0)
    parser.add_argument("--embedder", default="pyannote/wespeaker-voxceleb-resnet34-LM")
    parser.add_argument("--write", type=float, default=None)
    # NeMo and pyannote live in different virtualenvs here, so the two stages
    # run as two commands with the window cache as the handoff.
    parser.add_argument("--windows-only", action="store_true")
    parser.add_argument("--oracle", action="store_true",
                        help="link by the reference: a ceiling, not a candidate")
    # Replacing the pooled vectors with noise leaves the window cannot-link
    # constraint and the merge machinery exactly as they are, so whatever the
    # result loses is what the voice similarity was contributing.
    parser.add_argument("--random-vectors", type=int, default=None,
                        metavar="SEED", help="ablation: replace embeddings with noise")
    args = parser.parse_args()

    # The window geometry is part of the cache identity. Keying only on the
    # stem silently reuses 90 s rows for a 30 s request, which would have made
    # a window-size sweep report the same numbers for every cell.
    cache = (f"eval/real/{args.stem}.sortformer-windows"
             f"-w{args.window:g}-h{args.hop:g}.json")
    if os.path.exists(cache):
        rows = json.load(open(cache))["rows"]
    else:
        rows = run_windows(args.stem, args.window, args.hop, args.model)
        json.dump({"window": args.window, "hop": args.hop, "rows": rows}, open(cache, "w"))

    if args.windows_only:
        raise SystemExit(f"cached {len(rows)} window rows -> {cache}")

    audio, sample_rate = sf.read(f"fixtures/real/{args.stem}.wav", dtype="float32")
    if audio.ndim > 1:
        audio = audio.mean(axis=1)

    from embedders import load
    embed = load(args.embedder)

    # Embedding is the expensive half and does not depend on the threshold, so
    # it happens once and the sweep is pure arithmetic.
    keys, vectors, pooled_seconds, skipped = pooled_vectors(
        rows, audio, embed, args.min_pool, args.pool_cap)
    forbidden = simultaneous(rows, keys, args.overlap_tolerance)
    pairs_blocked = int(forbidden.sum()) // 2
    print(f"{len(keys)} window-local speakers pooled, {skipped} below "
          f"{args.min_pool:g}s of clean speech; {pairs_blocked} pairs proven "
          f"different by simultaneous speech")

    if args.oracle:
        mapping, people = oracle_mapping(rows, keys, args.stem)
        turns = to_turns(rows, mapping, args.hop, args.window)
        path = f"eval/real/{args.stem}.sortpool-oracle.json"
        json.dump({"turns": turns}, open(path, "w"))
        print(f"oracle linking: {people} people, {len(turns)} turns -> {path}")
        raise SystemExit

    if args.random_vectors is not None:
        generator = np.random.default_rng(args.random_vectors)
        vectors = generator.normal(size=vectors.shape)
        vectors /= np.linalg.norm(vectors, axis=1, keepdims=True)
        print(f"ABLATION: pooled vectors replaced with noise, seed {args.random_vectors}")

    thresholds = [args.write] if args.write else [float(x) for x in args.thresholds.split(",")]
    penalties = ([args.penalty] if args.penalties is None
                 else [float(x) for x in args.penalties.split(",")])
    for penalty, threshold in ((p, t) for p in penalties for t in thresholds):
        mapping, people = assign(keys, vectors, pooled_seconds, threshold,
                                 forbidden, penalty)
        turns = to_turns(rows, mapping, args.hop, args.window)
        seconds: dict[str, float] = {}
        for turn in turns:
            seconds[turn["speaker"]] = seconds.get(turn["speaker"], 0.0) + (
                turn["end_ms"] - turn["start_ms"]) / 1000
        share = max(seconds.values()) / sum(seconds.values()) if seconds else 0.0
        # Window geometry belongs in the name for the same reason it belongs in
        # the cache key: two windows write the same cell, and a file that does
        # not say which one produced it cannot be checked afterwards.
        tag = "" if args.random_vectors is None else f"-rand{args.random_vectors}"
        path = (f"eval/real/{args.stem}.sortpool"
                f"-w{args.window:g}-h{args.hop:g}-p{penalty:g}-t{threshold:g}{tag}.json")
        json.dump({"turns": turns}, open(path, "w"))
        print(f"penalty {penalty:.2f} threshold {threshold:.2f}: {people} people, "
              f"{len(turns)} turns, top label {100 * share:.0f}% -> {path}")
