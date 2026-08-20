"""Are two people in this recording distinguishable by voice at all?

Three unrelated diarizers - pyannote 3.1 with agglomerative clustering,
community-1 with VBx/PLDA, and Sortformer end to end with no clustering stage -
all collapse mentra-mtg into one label holding about 70% of the speech, and all
three put the same question-and-answer exchanges inside it. When systems that
share no code agree, the thing they share is the audio, so this measures the
audio.

A question and the reply that follows it within two seconds are two different
people, and the transcript says so without any voiceprint being involved. That
gives a set of known different-speaker pairs for free, on a recording with no
reference. Against it sit known same-speaker pairs: two clips from one
uninterrupted stretch of speech. If the different-speaker pairs score as close
together as the same-speaker pairs, the voices are not separable and no
clustering or segmentation choice can recover them.

  python eval/real/pair_separability.py <stem> [...]
"""

import json
import sys

import numpy as np
import soundfile as sf
import torch
from speechbrain.inference.speaker import EncoderClassifier

SAMPLE_RATE = 16000
MIN_CLIP = 0.8
MAX_GAP = 2.0

model = EncoderClassifier.from_hparams(
    source="speechbrain/spkrec-ecapa-voxceleb",
    savedir="sidecar/.cache/ecapa",
    run_opts={"device": "cpu"},
)


def sentences_of(stem: str) -> list[dict]:
    whisper = json.load(open(f"fixtures/real/{stem}.whisper.json"))
    if "segments" in whisper:
        return [{"start": s["start"], "end": s["end"], "text": s["text"].strip()}
                for s in whisper["segments"] if s["text"].strip()]
    rows, words, cursor, start, current = [], whisper["words"], 0, None, []
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
    return rows


def embed(audio: np.ndarray, start: float, end: float) -> np.ndarray | None:
    clip = audio[int(start * SAMPLE_RATE):int(end * SAMPLE_RATE)]
    if len(clip) < MIN_CLIP * SAMPLE_RATE:
        return None
    with torch.no_grad():
        vector = model.encode_batch(torch.from_numpy(clip).unsqueeze(0)).squeeze()
    return (vector / vector.norm(p=2)).numpy()


for stem in sys.argv[1:]:
    audio, sample_rate = sf.read(f"fixtures/real/{stem}.wav", dtype="float32")
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    assert sample_rate == SAMPLE_RATE, sample_rate
    sentences = sentences_of(stem)

    different = []
    for earlier, later in zip(sentences, sentences[1:]):
        if not earlier["text"].endswith("?") or later["text"].endswith("?"):
            continue
        if later["start"] - earlier["end"] > MAX_GAP:
            continue
        a, b = embed(audio, earlier["start"], earlier["end"]), embed(audio, later["start"], later["end"])
        if a is not None and b is not None:
            different.append(float(a @ b))

    # Same speaker: two halves of one sentence long enough to split, with no
    # neighbouring speech close enough to have leaked into it.
    same = []
    for index, sentence in enumerate(sentences):
        span = sentence["end"] - sentence["start"]
        if span < 2 * MIN_CLIP + 0.2:
            continue
        before = sentences[index - 1]["end"] if index else -9
        after = sentences[index + 1]["start"] if index + 1 < len(sentences) else 9e9
        # Only a small guard on each side: both halves come from one sentence,
        # so the risk is a neighbour bleeding in at the edges, not the halves
        # belonging to different people.
        if sentence["start"] - before < 0.25 or after - sentence["end"] < 0.25:
            continue
        middle = (sentence["start"] + sentence["end"]) / 2
        a = embed(audio, sentence["start"], middle - 0.1)
        b = embed(audio, middle + 0.1, sentence["end"])
        if a is not None and b is not None:
            same.append(float(a @ b))
        if len(same) >= 200:
            break

    if not different or not same:
        print(f"{stem}: not enough pairs ({len(different)} different, {len(same)} same)")
        continue

    different_array, same_array = np.array(different), np.array(same)
    # Probability a random same-speaker pair scores above a random
    # different-speaker pair: 0.5 is chance, 1.0 is perfect separation.
    auc = float((same_array[:, None] > different_array[None, :]).mean())
    print(f"{stem}: {len(same)} same-speaker pairs, {len(different)} question-and-answer pairs")
    print(f"   same speaker      cosine {same_array.mean():.3f} +- {same_array.std():.3f}")
    print(f"   different speaker cosine {different_array.mean():.3f} +- {different_array.std():.3f}")
    print(f"   separation AUC {auc:.3f}   (0.5 is chance)")
