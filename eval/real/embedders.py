"""One way to ask any speaker-embedding model for a batch of vectors.

Four lineages, so "two models agree" can be tested against a model that is not
a cousin of the other two:

  pyannote/wespeaker-...      ResNet34 on filterbanks
  speechbrain/spkrec-ecapa    ECAPA-TDNN on filterbanks
  speechbrain/spkrec-xvect    x-vector TDNN, the older generation
  microsoft/wavlm-base-plus-sv  self-supervised transformer front end

Takes (batch, samples) float32 at 16 kHz and returns (batch, dim) unnormalised.
"""

import os

import numpy as np
import torch


def load(checkpoint: str):
    if checkpoint.startswith("microsoft/"):
        from transformers import AutoFeatureExtractor, WavLMForXVector

        features = AutoFeatureExtractor.from_pretrained(checkpoint)
        model = WavLMForXVector.from_pretrained(checkpoint).eval()

        def embed(block: np.ndarray) -> np.ndarray:
            prepared = features(
                list(block), sampling_rate=16_000, return_tensors="pt", padding=True
            )
            with torch.no_grad():
                return model(**prepared).embeddings.numpy()

        return embed

    if checkpoint.startswith("speechbrain/"):
        from speechbrain.inference.speaker import EncoderClassifier

        classifier = EncoderClassifier.from_hparams(source=checkpoint, run_opts={"device": "cpu"})

        def embed(block: np.ndarray) -> np.ndarray:
            return classifier.encode_batch(torch.from_numpy(block)).squeeze(1).detach().numpy()

        return embed

    if checkpoint.startswith("nvidia/"):
        import nemo.collections.asr as nemo_asr

        model = nemo_asr.models.EncDecSpeakerLabelModel.from_pretrained(
            model_name=checkpoint.split("/", 1)[1]
        ).eval()

        def embed(block: np.ndarray) -> np.ndarray:
            lengths = torch.full((len(block),), block.shape[1], dtype=torch.int32)
            with torch.no_grad():
                _, vectors = model.forward(
                    input_signal=torch.from_numpy(block), input_signal_length=lengths
                )
            return vectors.numpy()

        return embed

    from pyannote.audio.pipelines.speaker_verification import PretrainedSpeakerEmbedding

    embedder = PretrainedSpeakerEmbedding(checkpoint, token=os.environ["HF_TOKEN"])

    def embed(block: np.ndarray) -> np.ndarray:
        return embedder(torch.from_numpy(block).unsqueeze(1))

    return embed
