"""Run NVIDIA Sortformer, an end-to-end diarizer that models overlap natively.

Only TitaNet embeddings were ever tested from NeMo here, and only in a
clip-to-clip verification framing we now know is the wrong framing. Sortformer
is the actual diarizer: it emits per-speaker activity directly from the audio,
so there is no clustering stage to misconfigure and overlapping speech is a
first-class output rather than a segmentation artifact. That matters here
because the 48-minute recording holds 776 s of simultaneous speech.

NeMo 3.0 removed MSDD (`NeuralDiarizer`/`EncDecDiarLabelModel`); Sortformer is
its replacement. The published checkpoints are 4-speaker models, so dorm-40min
(7 people) and mentra-mtg (5) are beyond their capacity by construction - run
anyway and report it, because a capacity ceiling is a finding.

  python eval/real/sortformer_run.py <stem> [--model diar_sortformer_4spk-v1]
"""

import argparse
import json
import time
import warnings

warnings.filterwarnings("ignore")

import numpy as np
import soundfile as sf
import torch
from nemo.collections.asr.models import SortformerEncLabelModel

parser = argparse.ArgumentParser()
parser.add_argument("stem")
parser.add_argument("--model", default="nvidia/diar_sortformer_4spk-v1")
parser.add_argument("--tag", default="")
parser.add_argument("--device", default="cpu")
args = parser.parse_args()

model = SortformerEncLabelModel.from_pretrained(args.model, map_location=args.device)
model.eval()

audio, sample_rate = sf.read(f"fixtures/real/{args.stem}.wav", dtype="float32")
if audio.ndim > 1:
    audio = audio.mean(axis=1)

started = time.time()
predictions = model.diarize(audio=np.asarray(audio, dtype=np.float32).reshape(1, -1),
                            sample_rate=sample_rate, batch_size=1, verbose=False)
elapsed = time.time() - started

# Each prediction row is "start end speaker_N" in seconds.
turns = []
for row in predictions[0]:
    start, end, speaker = str(row).split()
    turns.append({
        "start_ms": int(round(float(start) * 1000)),
        "end_ms": int(round(float(end) * 1000)),
        "speaker": speaker,
    })
turns.sort(key=lambda t: (t["start_ms"], t["end_ms"]))

out = f"eval/real/{args.stem}.sortformer{args.tag}.json"
json.dump({"turns": turns}, open(out, "w"))

per_speaker: dict[str, float] = {}
for turn in turns:
    per_speaker[turn["speaker"]] = per_speaker.get(turn["speaker"], 0.0) + (
        turn["end_ms"] - turn["start_ms"]) / 1000
overlap = 0.0
for index, a in enumerate(turns):
    for b in turns[index + 1:]:
        if b["start_ms"] >= a["end_ms"]:
            break
        if b["speaker"] != a["speaker"]:
            overlap += max(0, min(a["end_ms"], b["end_ms"]) - max(a["start_ms"], b["start_ms"])) / 1000

audio_seconds = len(audio) / sample_rate
print(f"{args.stem} -> {out}: {len(turns)} turns, {len(per_speaker)} speakers, "
      f"{elapsed:.0f}s for {audio_seconds:.0f}s ({audio_seconds / max(elapsed, 1e-9):.1f}x realtime)")
for speaker, seconds in sorted(per_speaker.items(), key=lambda kv: -kv[1]):
    print(f"   {speaker}: {seconds:7.1f}s")
print(f"   simultaneous speech detected: {overlap:.1f}s")
