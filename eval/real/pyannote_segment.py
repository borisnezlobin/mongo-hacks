"""Overlap-aware segmentation, driven directly.

pyannote's segmentation model predicts, for each frame of a short window, WHICH
SUBSET of the local speakers is talking -- so two people at once is a class the
model can output, not an error it has to be protected from. That is the piece
this project never had: everything upstream assumed one speaker per instant.

The packaged pipeline wants a third gated repo for PLDA clustering, so this
drives the segmentation model itself and clusters with the method already
measured on this audio.
"""
import os, sys, json
import numpy as np, soundfile as sf, torch
from pyannote.audio import Model, Inference
from pyannote.audio.utils.powerset import Powerset

stem = sys.argv[1]
seg = Model.from_pretrained('pyannote/segmentation-3.0', token=os.environ['HF_TOKEN'])
spec = seg.specifications
print('powerset classes:', spec.num_powerset_classes,
      '| max simultaneous:', spec.powerset_max_classes,
      '| local speakers:', len(spec.classes))

inf = Inference(seg, duration=seg.specifications.duration, step=seg.specifications.duration / 2,
                skip_aggregation=True, batch_size=8)
# Load the waveform directly: pyannote 4 reads files through torchcodec, whose
# native library will not link against the ffmpeg on this machine.
wav, sr = sf.read(f'fixtures/real/{stem}.wav', dtype='float32')
out = inf({'waveform': torch.from_numpy(wav).unsqueeze(0), 'sample_rate': sr})
data = out.data                     # (num_windows, num_frames, num_powerset_classes)
print('windows:', data.shape)

ps = Powerset(len(spec.classes), spec.powerset_max_classes)
multi = ps.to_multilabel(torch.from_numpy(data).float()).numpy()   # (win, frames, speakers)
np.savez(f'eval/real/{stem}.segmentation.npz',
         multi=multi.astype('float32'),
         starts=np.array([w.start for w in out.sliding_window]),
         frame_step=out.sliding_window.step / multi.shape[1],
         win_duration=out.sliding_window.duration)

active = multi.sum(axis=2)
frames = active.size
print(f'frames with 0 speakers: {100*(active==0).mean():.1f}%')
print(f'frames with 1 speaker : {100*(active==1).mean():.1f}%')
print(f'frames with 2+        : {100*(active>=2).mean():.1f}%   <- overlap the old pipeline could not express')
