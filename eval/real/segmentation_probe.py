"""How many speakers does segmentation find inside each 10-second chunk?

Clustering can only separate people that segmentation already put in different
slots. If a chunk covering a question and its answer has just one slot active,
the two voices are averaged into one embedding before clustering ever sees them,
and no clustering parameter can undo that.

So this counts, per chunk, how many of the local speaker slots are active, and
how much speech sits in chunks that found only one. Compared across recordings
it says whether a recording's problem is upstream of clustering.

  python eval/real/segmentation_probe.py <stem> [...]
"""

import sys

import numpy as np

sys.path.insert(0, "eval/real")

for stem in sys.argv[1:]:
    cache = np.load(f"eval/real/{stem}.community1.stage1.npz")
    segmentations = cache["segmentations"]  # (chunks, frames, local speakers)
    start, duration, step = cache["window"]

    # A slot counts as active in a chunk if it holds speech for at least a
    # tenth of a second, which is shorter than any real turn.
    frame_seconds = duration / segmentations.shape[1]
    slot_seconds = segmentations.sum(axis=1) * frame_seconds
    active = slot_seconds > 0.1
    per_chunk = active.sum(axis=1)

    speech = slot_seconds.sum(axis=1)
    voiced = per_chunk > 0
    counts = np.bincount(per_chunk[voiced], minlength=segmentations.shape[2] + 1)
    single = speech[per_chunk == 1].sum()
    total = speech[voiced].sum()

    print(f"{stem}: {segmentations.shape[0]} chunks of {duration:.0f}s, "
          f"{total:.0f}s of slot speech")
    detail = "  ".join(
        f"{n} speaker{'s' if n != 1 else ''}: {counts[n]} chunks ({100 * counts[n] / max(voiced.sum(), 1):.0f}%)"
        for n in range(1, len(counts)) if counts[n]
    )
    print(f"   {detail}")
    print(f"   {100 * single / max(total, 1e-9):.0f}% of slot speech sits in chunks "
          f"where segmentation found only one speaker")
