"""Re-attribute whole turns against pooled voices, the way the product would.

`pooled_floor.py` measured the pooled question with pools built from REFERENCE
spans, which is an upper bound because it needs the answer to build the pools.
This builds the pools from the pipeline's own output instead: take the turns the
shipping diarization already emitted, keep the long ones as evidence about who
each label is, average them into one voice per label, and then ask every turn --
long and short -- which of those voices it is closest to.

Nothing here uses the reference to decide anything. The reference is only read to
score. So the numbers this prints are product numbers, and the difference
between them and pooled_floor.py's is the price of not knowing the answer.

Three things it reports that the landmark counts cannot:

  turn-label accuracy bucketed by turn duration, which is where a claim about
  short fragments has to be settled;
  how much speech goes unattributed, which is the price of abstention;
  the abstention trade in correct-names-lost per wrong-name-avoided, which is
  the number a blanket duration floor scored 2.7 on.

  sidecar/.venv/bin/python eval/real/pooled_turns.py dorm-40min \
      --pool-min 4 --abstain 0,0.4,0.5,0.6 --margins 0,0.02,0.05

Set --pools reference to rebuild the upper bound through this same code path,
so the two are comparable rather than merely adjacent.
"""

import argparse
import json
import os
import sys

import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from embedders import load  # noqa: E402

EMBED_CAP_S = 20.0
BUCKETS = [(0, 0.5), (0.5, 1), (1, 2), (2, 4), (4, 8), (8, 1e9)]


def embed_spans(audio, sr, spans, embed_batch, batch=16):
    """One vector per span, unit-normalised. Long spans are capped, not chunked.

    A twenty-second cap is not a modelling choice, it is a memory one: the
    embedder pads a batch to its longest member, and one four-minute turn would
    otherwise decide the size of every block.
    """
    vectors = np.zeros((len(spans), 0))
    out = []
    for start in range(0, len(spans), batch):
        group = spans[start : start + batch]
        width = max(
            int(min(hi - lo, EMBED_CAP_S) * sr) for lo, hi in group
        )
        width = max(width, int(0.2 * sr))
        block = np.zeros((len(group), width), dtype="float32")
        for row, (lo, hi) in enumerate(group):
            clip = audio[max(int(lo * sr), 0) : max(int(lo * sr), 0) + width]
            block[row, : len(clip)] = clip
        got = np.asarray(embed_batch(block), dtype="float64")
        out.append(got / np.maximum(np.linalg.norm(got, axis=1, keepdims=True), 1e-9))
        print(f"  embedded {min(start + batch, len(spans))}/{len(spans)}", end="\r", flush=True)
    print(" " * 40, end="\r")
    return np.concatenate(out) if out else vectors


def dominant_owner(turn, reference):
    per = {}
    for span in reference:
        shared = min(turn["end_ms"], span["end_ms"]) - max(turn["start_ms"], span["start_ms"])
        if shared > 0:
            per[span["speaker"]] = per.get(span["speaker"], 0) + shared
    if not per:
        return None, 0.0, 0.0
    owner = max(per, key=per.get)
    total = sum(per.values())
    return owner, per[owner] / total, total / 1000


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("stem")
    parser.add_argument("--turns", default="")
    parser.add_argument("--pool-min", default="2,3,4,6,8")
    parser.add_argument("--abstain", default="0")
    parser.add_argument("--margins", default="0")
    parser.add_argument("--pools", default="labels", choices=["labels", "reference"])
    parser.add_argument(
        "--queries", default="turns", choices=["turns", "sentences"],
        help="what gets attributed. `turns` re-labels the diarizer's own turns, which "
             "can never cut one open. `sentences` uses whisper's sentence timings as the "
             "fragments instead: whisper puts a boundary at 20.84s, exactly the seam "
             "inside the 6.16s turn that no audio method has located, so this is the one "
             "granularity at which pooled matching is even allowed to answer that case.",
    )
    parser.add_argument("--out", default="")
    args = parser.parse_args()

    checkpoint = os.environ.get("SPK_MODEL", "pyannote/wespeaker-voxceleb-resnet34-LM")
    turns_path = args.turns or f"fixtures/real/{args.stem}.pyannote.json"
    turns = json.load(open(turns_path))["turns"]
    reference = json.load(open(f"eval/real/{args.stem}.reference.json"))["spans"]
    queries = turns
    if args.queries == "sentences":
        whisper = json.load(open(f"fixtures/real/{args.stem}.whisper.json"))
        queries = [
            {"start_ms": int(segment["start"] * 1000), "end_ms": int(segment["end"] * 1000),
             "text": segment["text"].strip()}
            for segment in whisper["segments"]
            if segment["end"] > segment["start"]
        ]
        # A sentence inherits the label of whichever diarizer turn covers most of
        # it -- the same rule word-join uses -- so the baseline column is what the
        # product prints today, not a weaker straw man.
        for query in queries:
            best_label, best_overlap = "", 0
            for turn in turns:
                shared = min(query["end_ms"], turn["end_ms"]) - max(query["start_ms"], turn["start_ms"])
                if shared > best_overlap:
                    best_label, best_overlap = turn["speaker"], shared
            query["speaker"] = best_label
    audio, sr = sf.read(f"fixtures/real/{args.stem}.wav", dtype="float32")

    def cached_vectors(path, key, spans):
        """Embeddings are the expensive half; cache them keyed by what made them."""
        if os.path.exists(path):
            blob = np.load(path, allow_pickle=True)
            if str(blob["key"]) == key:
                return blob["vectors"]
        print(f"embedding {len(spans)} spans with {checkpoint}")
        vectors = embed_spans(
            audio, sr, [(s["start_ms"] / 1000, s["end_ms"] / 1000) for s in spans],
            load(checkpoint),
        )
        np.savez_compressed(path, vectors=vectors, key=key)
        return vectors

    pool_vectors = cached_vectors(
        f"eval/real/{args.stem}.turnemb.npz",
        f"{turns_path}|{checkpoint}|{len(turns)}",
        turns,
    )
    vectors = (
        pool_vectors
        if queries is turns
        else cached_vectors(
            f"eval/real/{args.stem}.{args.queries}emb.npz",
            f"{args.stem}|{checkpoint}|{args.queries}|{len(queries)}",
            queries,
        )
    )

    pool_seconds = np.array([(t["end_ms"] - t["start_ms"]) / 1000 for t in turns])
    pool_labels = np.array([t["speaker"] for t in turns])
    seconds = np.array([(q["end_ms"] - q["start_ms"]) / 1000 for q in queries])
    labels = np.array([q["speaker"] for q in queries])
    owners, purities, labelled = [], [], []
    for turn in queries:
        owner, purity, seen = dominant_owner(turn, reference)
        owners.append(owner)
        purities.append(purity)
        labelled.append(seen)
    owners = np.array([o if o else "" for o in owners])
    labelled = np.array(labelled)
    judged = (owners != "") & (labelled >= 0.5)

    print(
        f"{args.stem}: pools from {len(turns)} diarizer turns; "
        f"{len(queries)} {args.queries} to attribute, {seconds.sum():.0f}s; "
        f"{judged.sum()} of them carry >=0.5s of reference speech"
    )

    for pool_min in [float(v) for v in args.pool_min.split(",") if v]:
        if args.pools == "labels":
            members = {}
            for index, label in enumerate(pool_labels):
                if pool_seconds[index] >= pool_min:
                    members.setdefault(label, []).append(index)
            names = sorted(members)
        else:
            # The upper bound: pools built from reference spans, which needs the
            # answer to build. Kept in the same code path so the gap between it
            # and the product pools is a measurement and not two studies.
            members = {}
            for index, turn in enumerate(turns):
                owner, purity, seen = dominant_owner(turn, reference)
                if owner and pool_seconds[index] >= pool_min and purity >= 0.9:
                    members.setdefault(owner, []).append(index)
            names = sorted(members)
        if len(names) < 2:
            print(f"  pool>={pool_min}s: only {len(names)} pools, skipping")
            continue

        member_of = {name: set(rows) for name, rows in members.items()}
        sums = np.vstack([pool_vectors[members[name]].sum(axis=0) for name in names])
        counts = np.array([len(members[name]) for name in names], dtype="float64")
        # A query is only "its own" pool member when the query set IS the pool
        # set. Sentences are separate spans, so nothing is held out for them --
        # and nothing needs to be, because a sentence never built a centroid.
        holds_out = queries is turns

        # Leave the turn's own vector out of any pool it belongs to, so a long
        # turn is never scored against a centroid it helped build.
        distances = np.zeros((len(queries), len(names)))
        for column, name in enumerate(names):
            own = np.array(
                [holds_out and index in member_of[name] for index in range(len(queries))]
            )
            total = np.where(own[:, None], sums[column] - vectors, sums[column])
            size = np.where(own, counts[column] - 1, counts[column])
            centroid = total / np.maximum(size, 1)[:, None]
            centroid /= np.maximum(np.linalg.norm(centroid, axis=1, keepdims=True), 1e-9)
            distances[:, column] = 1 - (vectors * centroid).sum(axis=1)
            distances[size <= 0, column] = np.inf

        order = np.argsort(distances, axis=1)
        best = distances[np.arange(len(queries)), order[:, 0]]
        second = distances[np.arange(len(queries)), order[:, 1]]
        picked = np.array(names, dtype=object)[order[:, 0]]

        # Name each pool by the person who holds most of its judged turn-seconds.
        # For reference pools that is the identity map; for label pools it is the
        # only way to score a nameless SPEAKER_04 against a person.
        def name_by_dominant(assignment):
            weight = {}
            for index in np.flatnonzero(judged):
                key = (assignment[index], owners[index])
                weight[key] = weight.get(key, 0) + seconds[index]
            naming = {}
            for (group, owner), value in sorted(weight.items(), key=lambda kv: -kv[1]):
                naming.setdefault(group, owner)
            return naming

        # Each side is named by its OWN dominant person. Naming the diarizer's
        # labels through the pooled assignment would move the baseline whenever
        # pooling moved, and then the comparison would be against a shifting
        # thing rather than against the shipping pipeline.
        pool_naming = name_by_dominant(picked)
        label_naming = name_by_dominant(labels)

        baseline_right = np.array(
            [label_naming.get(labels[i], None) == owners[i] for i in range(len(queries))]
        )
        pooled_right = np.array(
            [pool_naming.get(picked[i], None) == owners[i] for i in range(len(queries))]
        )

        header = (
            f"  pools={args.pools} >= {pool_min}s: {len(names)} pools, "
            f"{int(counts.sum())} member turns"
        )
        print(header)
        for abstain in [float(v) for v in args.abstain.split(",") if v != ""]:
            for margin in [float(v) for v in args.margins.split(",") if v != ""]:
                keep = np.ones(len(queries), dtype=bool)
                if abstain > 0:
                    keep &= best <= abstain
                if margin > 0:
                    keep &= (second - best) >= margin
                scored = judged & keep
                dropped = judged & ~keep
                lost = int((baseline_right & dropped).sum())
                saved = int((~baseline_right & dropped).sum())
                line = (
                    f"    abstain d>{abstain:.2f} margin<{margin:.2f}: "
                    f"kept {100 * seconds[keep].sum() / seconds.sum():5.1f}% of speech  "
                    f"pooled {100 * pooled_right[scored].sum() / max(scored.sum(), 1):5.1f}%  "
                    f"(diarizer {100 * baseline_right[scored].sum() / max(scored.sum(), 1):5.1f}%)"
                )
                keep_last = keep
                if abstain > 0 or margin > 0:
                    line += (
                        f"  | abstained on {dropped.sum():4d} judged turns: "
                        f"{lost} were right, {saved} were wrong "
                        f"({lost / max(saved, 1):.1f} correct names lost per wrong one)"
                    )
                print(line)

        print("    by turn duration (no abstention):")
        for lo, hi in BUCKETS:
            inside = judged & (seconds >= lo) & (seconds < hi)
            if inside.sum() == 0:
                continue
            print(
                f"      {lo:5.1f}-{hi if hi < 1e8 else 99:4.0f}s  n={inside.sum():4d}  "
                f"diarizer {100 * baseline_right[inside].sum() / inside.sum():5.1f}%  "
                f"pooled {100 * pooled_right[inside].sum() / inside.sum():5.1f}%  "
                f"median d={np.median(best[inside]):.3f}"
            )

        if args.out:
            os.makedirs(args.out, exist_ok=True)
            relabelled = [
                {"start_ms": query["start_ms"], "end_ms": query["end_ms"],
                 "speaker": str(picked[index])}
                for index, query in enumerate(queries)
                if keep_last[index]
            ]
            name = f"{args.stem}__pooled{pool_min}_{args.pools}_{args.queries}"
            # The control. Same spans, same join, but each fragment keeps the
            # label it inherited from the diarizer instead of being matched
            # against a pool. Without it, any gain from re-segmenting on
            # whisper's sentence boundaries would be credited to pooling.
            if args.queries != "turns":
                inherited = [
                    {"start_ms": query["start_ms"], "end_ms": query["end_ms"],
                     "speaker": str(labels[index])}
                    for index, query in enumerate(queries)
                    if keep_last[index] and labels[index]
                ]
                json.dump(
                    {"turns": inherited,
                     "speakers": sorted({t["speaker"] for t in inherited}),
                     "config": {"pool_min_s": pool_min, "pools": "inherited-control"}},
                    open(os.path.join(args.out, f"{args.stem}__control_{args.queries}.json"), "w"),
                )
            json.dump(
                {
                    "turns": relabelled,
                    "speakers": sorted({t["speaker"] for t in relabelled}),
                    "config": {"pool_min_s": pool_min, "pools": args.pools},
                },
                open(os.path.join(args.out, f"{name}.json"), "w"),
            )


if __name__ == "__main__":
    main()
