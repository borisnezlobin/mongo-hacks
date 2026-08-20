"""Denoise the recording, so the same measurements can be re-run on the result.

The owner can follow the conversation by ear and asked whether denoising would
help. It is a fair question with a non-obvious answer: enhancement is trained
for intelligibility, and the detail it removes as noise overlaps with the detail
a speaker-embedding model uses. It can plausibly go either way, so it gets
measured rather than argued about.

  python eval/real/enhance.py dorm-40min [checkpoint]

Writes eval/real/<stem>.<tag>.wav, which stays in the repo and stays gitignored
like everything else derived from these recordings. Point the duration and
pooled studies at it with ENHANCE_WAV=... to get a like-for-like comparison.
"""

import os
import sys

import numpy as np
import soundfile as sf
import torch

stem = sys.argv[1]
checkpoint = sys.argv[2] if len(sys.argv) > 2 else "speechbrain/metricgan-plus-voicebank"
tag = checkpoint.split("/")[-1].split("-")[0]
CHUNK_S = 30.0

source = f"fixtures/real/{stem}.wav"
target = f"eval/real/{stem}.{tag}.wav"
info = sf.info(source)
sr = info.samplerate

if "sepformer" in checkpoint:
    from speechbrain.inference.separation import SepformerSeparation as Model

    model = Model.from_hparams(source=checkpoint, run_opts={"device": "cpu"})

    def run(block: torch.Tensor) -> np.ndarray:
        # Separation returns sources; the loudest one is the enhanced speech.
        estimates = model.separate_batch(block)[0].detach().numpy()
        return estimates[:, int(np.argmax((estimates**2).mean(axis=0)))]
else:
    from speechbrain.inference.enhancement import SpectralMaskEnhancement as Model

    model = Model.from_hparams(source=checkpoint, run_opts={"device": "cpu"})

    def run(block: torch.Tensor) -> np.ndarray:
        lengths = torch.ones(block.shape[0])
        return model.enhance_batch(block, lengths=lengths)[0].detach().numpy()


print(f"{checkpoint} -> {target}", flush=True)
written = 0
with sf.SoundFile(target, "w", samplerate=sr, channels=1, subtype="PCM_16") as out:
    for start in range(0, info.frames, int(CHUNK_S * sr)):
        clip, _ = sf.read(source, dtype="float32", start=start, stop=min(start + int(CHUNK_S * sr), info.frames))
        enhanced = run(torch.from_numpy(clip).unsqueeze(0))
        enhanced = np.asarray(enhanced, dtype="float32").reshape(-1)[: len(clip)]
        peak = float(np.abs(enhanced).max())
        if peak > 1.0:
            enhanced = enhanced / peak
        out.write(enhanced)
        written += len(enhanced)
        if written % (int(CHUNK_S * sr) * 20) == 0:
            print(f"  {written / sr:.0f}s of {info.frames / sr:.0f}s", flush=True)
print(f"wrote {target}, {written / sr:.0f}s", flush=True)
