"""Run pyannote's community-1 pipeline, whose clustering is VBx/PLDA.

community-1 shares segmentation-3.0 weights with the 3.1 pipeline bit for bit,
which is why an earlier reading concluded it could not help. That inference was
wrong: the two pipelines differ at the clustering stage, which is the stage that
is broken here. 3.1 runs AgglomerativeClustering over cosine distance;
community-1 runs a VB-HMM over PLDA-scored embeddings, using the plda.npz and
xvec_transform.npz that ship only with community-1.

  python eval/real/community1_run.py <stem> [--threshold T] [--fa A] [--fb B]

Writes eval/real/<stem>.community1[.tag].json in the fixture turn shape.
"""

import argparse
import json
import os
import time

import numpy as np
import soundfile as sf
import torch
from pyannote.audio import Pipeline

parser = argparse.ArgumentParser()
parser.add_argument("stem")
parser.add_argument("--threshold", type=float, default=None)
parser.add_argument("--fa", type=float, default=None)
parser.add_argument("--fb", type=float, default=None)
parser.add_argument("--speakers", type=int, default=None)
parser.add_argument("--tag", default="")
parser.add_argument("--device", default="mps")
parser.add_argument("--channel", default="mix", choices=["mix","left","right","difference"])
args = parser.parse_args()

pipeline = Pipeline.from_pretrained(
    "pyannote/speaker-diarization-community-1", token=os.environ["HF_TOKEN"]
)
if args.device != "cpu":
    pipeline.to(torch.device(args.device))

overrides = {}
if args.threshold is not None:
    overrides["threshold"] = args.threshold
if args.fa is not None:
    overrides["Fa"] = args.fa
if args.fb is not None:
    overrides["Fb"] = args.fb
if overrides:
    params = pipeline.parameters(instantiated=True)
    params["clustering"].update(overrides)
    pipeline.instantiate(params)

if args.channel == "mix":
    audio, sample_rate = sf.read(f"fixtures/real/{args.stem}.wav", dtype="float32")
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
else:
    # The mono fixtures average two channels that are only about 0.85
    # correlated, and averaging them measurably costs the segmentation model
    # its second speaker slot. These read the channels as recorded instead.
    stereo, sample_rate = sf.read(f"fixtures/real/{args.stem}.stereo.wav", dtype="float32")
    if args.channel == "left":
        audio = stereo[:, 0]
    elif args.channel == "right":
        audio = stereo[:, 1]
    elif args.channel == "difference":
        audio = stereo[:, 0] - stereo[:, 1]
    else:
        raise SystemExit(f"unknown channel {args.channel}")
audio = np.ascontiguousarray(audio, dtype=np.float32)

# Waveform passed directly: pyannote 4 reads files via torchcodec, whose native
# library does not link against the ffmpeg on this machine.
call = {"waveform": torch.from_numpy(audio).unsqueeze(0), "sample_rate": sample_rate}
started = time.time()
annotation = pipeline(call, num_speakers=args.speakers) if args.speakers else pipeline(call)
elapsed = time.time() - started

def to_turns(diarization) -> list[dict]:
    rows = [
        {"start_ms": int(round(segment.start * 1000)), "end_ms": int(round(segment.end * 1000)),
         "speaker": str(label)}
        for segment, _, label in diarization.itertracks(yield_label=True)
    ]
    rows.sort(key=lambda t: (t["start_ms"], t["end_ms"]))
    return rows


# community-1 returns both an overlap-aware diarization and an exclusive one in
# which at most one speaker holds any instant. Keep both: the overlap-aware
# version is the honest diarization, the exclusive version is the shape the
# word-join stage downstream can actually consume.
turns = to_turns(annotation.speaker_diarization)
exclusive = to_turns(annotation.exclusive_speaker_diarization)

out = f"eval/real/{args.stem}.community1{args.tag}.json"
json.dump({"turns": turns}, open(out, "w"))
json.dump({"turns": exclusive}, open(
    f"eval/real/{args.stem}.community1{args.tag}.exclusive.json", "w"))

audio_seconds = len(audio) / sample_rate
per_speaker: dict[str, float] = {}
for turn in turns:
    per_speaker[turn["speaker"]] = per_speaker.get(turn["speaker"], 0) + (
        turn["end_ms"] - turn["start_ms"]
    ) / 1000
overlap = 0.0
for index, a in enumerate(turns):
    for b in turns[index + 1:]:
        if b["start_ms"] >= a["end_ms"]:
            break
        if b["speaker"] != a["speaker"]:
            overlap += max(0, min(a["end_ms"], b["end_ms"]) - max(a["start_ms"], b["start_ms"])) / 1000

print(
    f"{args.stem} -> {out}: {len(turns)} turns, {len(per_speaker)} speakers, "
    f"{elapsed:.0f}s for {audio_seconds:.0f}s ({audio_seconds / elapsed:.1f}x realtime)"
)
for speaker, seconds in sorted(per_speaker.items(), key=lambda kv: -kv[1]):
    print(f"   {speaker}: {seconds:7.1f}s")
print(f"   simultaneous speech detected: {overlap:.1f}s")
