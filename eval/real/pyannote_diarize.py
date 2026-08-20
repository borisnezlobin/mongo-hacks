"""Diarize with pyannote's overlap-aware segmentation + WeSpeaker embeddings.

This is what speaker-diarization-3.1 is: a segmentation model that predicts
which SUBSET of speakers is active per frame (so overlap is an output, not an
error), embeddings over the resulting speaker-pure regions, and clustering on
top. Assembling it from the two component models avoids needing the pipeline
repo, which is separately gated.
"""
import os, sys, json
import torch
from pyannote.audio import Model
from pyannote.audio.pipelines import SpeakerDiarization

stem = sys.argv[1]
tok = os.environ['HF_TOKEN']

seg = Model.from_pretrained('pyannote/segmentation-3.0', token=tok)
emb = Model.from_pretrained('pyannote/wespeaker-voxceleb-resnet34-LM', token=tok)

pipe = SpeakerDiarization(segmentation=seg, embedding=emb, clustering='AgglomerativeClustering')
# The published 3.1 operating point.
pipe.instantiate({
    'clustering': {'method': 'centroid', 'min_cluster_size': 12, 'threshold': 0.7045654963945799},
    'segmentation': {'min_duration_off': 0.0},
})

wav = f'fixtures/real/{stem}.wav'
print(f'diarizing {wav} ...', flush=True)
ann = pipe(wav)

out = []
for turn, _, speaker in ann.itertracks(yield_label=True):
    out.append({'start': float(turn.start), 'end': float(turn.end), 'speaker': str(speaker)})
json.dump({'segments': out}, open(f'eval/real/{stem}.pyannote.json', 'w'))

from collections import Counter
c = Counter(s['speaker'] for s in out)
total = sum(s['end'] - s['start'] for s in out)
print(f'{len(out)} turns, {len(c)} speakers, {total:.0f}s attributed')
for sp, n in c.most_common():
    secs = sum(s['end'] - s['start'] for s in out if s['speaker'] == sp)
    print(f'   {sp}: {n:4d} turns, {secs:6.1f}s')
