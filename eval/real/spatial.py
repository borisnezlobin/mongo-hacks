"""Where a voice is, from the two channels the phone actually recorded.

Every source .m4a is stereo and the pipeline throws one channel away at
conversion. Position is independent of timbre and, unlike an embedding, does
not need a long clip to estimate -- which is interesting precisely because
short clips are where embeddings fail.

Two cues per span:

  ILD   interaural level difference, 20 log10(rms L / rms R), in dB
  ITD   interaural time difference, from a GCC-PHAT peak with parabolic
        interpolation, in microseconds

The interpolation is not a refinement, it is the whole measurement. Two phone
microphones are centimetres apart, so a true ITD is well under 100 us, while one
sample at 16 kHz is 62.5 us. Without sub-sample interpolation the cue would be
quantised to about three distinguishable values and any structure in it would
be an artifact of the grid.
"""

import numpy as np

MAX_LAG = 8  # +-500 us at 16 kHz; far wider than two phone mics can produce


def gcc_phat_lag(left: np.ndarray, right: np.ndarray) -> float:
    """Sub-sample lag of right relative to left, in samples. Positive: right is later."""
    length = len(left)
    if length < 64:
        return 0.0
    size = 1 << (2 * length - 1).bit_length()
    spectrum = np.fft.rfft(left, size) * np.conj(np.fft.rfft(right, size))
    magnitude = np.abs(spectrum)
    spectrum = np.where(magnitude > 1e-12, spectrum / np.maximum(magnitude, 1e-12), 0)
    correlation = np.fft.irfft(spectrum, size)
    correlation = np.concatenate((correlation[-MAX_LAG:], correlation[: MAX_LAG + 1]))
    peak = int(np.argmax(correlation))
    if 0 < peak < len(correlation) - 1:
        before, at, after = correlation[peak - 1], correlation[peak], correlation[peak + 1]
        denominator = before - 2 * at + after
        offset = 0.0 if abs(denominator) < 1e-12 else 0.5 * (before - after) / denominator
    else:
        offset = 0.0
    return (peak - MAX_LAG) + float(np.clip(offset, -1, 1))


def features(audio: np.ndarray, sr: int, spans, cap_s: float = 20.0) -> np.ndarray:
    """(n, 2) array of [ILD dB, ITD us] for each (start_s, end_s) span."""
    out = np.zeros((len(spans), 2))
    for row, (lo, hi) in enumerate(spans):
        start = max(int(lo * sr), 0)
        stop = min(int(min(hi, lo + cap_s) * sr), len(audio))
        clip = audio[start:stop]
        if len(clip) < 64:
            continue
        left, right = clip[:, 0], clip[:, 1]
        power_left = float(np.sqrt(np.mean(left**2)) + 1e-9)
        power_right = float(np.sqrt(np.mean(right**2)) + 1e-9)
        out[row, 0] = 20 * np.log10(power_left / power_right)
        out[row, 1] = gcc_phat_lag(left, right) / sr * 1e6
    return out
