"""Can we pull two simultaneous speakers apart on this recording?

SepFormer is trained on 2-speaker mixtures. This asks whether running it over a
stretch where people talk over each other yields two streams that embed as two
DIFFERENT speakers -- which is the only reason to bother. If both outputs embed
to the same place, separation has produced two copies of the same blend.
"""
import numpy as np, soundfile as sf, torch
from speechbrain.inference.separation import SepformerSeparation
from speechbrain.inference.speaker import EncoderClassifier

SR=16000
audio,_=sf.read('fixtures/real/dorm-40min.wav',dtype='float32')

# Regions where the transcript shows two people trading words inside a couple of
# seconds -- the crosstalk the pipeline currently refuses to attribute.
REGIONS=[(24.0,30.0,'introductions: Boris and Vova'),
         (105.0,111.0,'two voices interleaved word by word'),
         (2316.0,2320.0,'the Drew introduction')]

spk=EncoderClassifier.from_hparams(source='speechbrain/spkrec-ecapa-voxceleb',
    savedir='sidecar/.cache/ecapa', run_opts={'device':'cpu'})
def emb(x):
    with torch.no_grad():
        v=spk.encode_batch(torch.as_tensor(x).float().unsqueeze(0)).squeeze()
    return (v/v.norm(p=2)).numpy()

sep=SepformerSeparation.from_hparams(source='speechbrain/sepformer-whamr16k',
    savedir='sidecar/.cache/sepformer', run_opts={'device':'cpu'})

for a,b,why in REGIONS:
    mix=audio[int(a*SR):int(b*SR)]
    with torch.no_grad():
        est=sep.separate_batch(torch.from_numpy(mix).unsqueeze(0))
    est=est.squeeze(0).numpy()          # (T, n_src)
    s1,s2=est[:,0],est[:,1]
    e_mix,e1,e2=emb(mix),emb(s1),emb(s2)
    print(f'\n{why}  ({b-a:.0f}s)')
    print(f'  separated streams vs each other : {float(e1@e2):+.3f}   (low = two different voices)')
    print(f'  stream 1 vs original mix        : {float(e1@e_mix):+.3f}')
    print(f'  stream 2 vs original mix        : {float(e2@e_mix):+.3f}')
    print(f'  energy split                    : {100*float((s1**2).sum()/((s1**2).sum()+(s2**2).sum())):.0f}% / '
          f'{100*float((s2**2).sum()/((s1**2).sum()+(s2**2).sum())):.0f}%')
