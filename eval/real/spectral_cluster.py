"""Cluster window embeddings into speakers, without being told how many.

Refinement chain from Wang et al., "Speaker Diarization with LSTM". Each step
exists because raw cosine between 1.5 s far-field windows is close to noise:
measured on speaker-certain clips from this recording, same-speaker averages
0.21 against 0.03 for different speakers, with the distributions overlapping
heavily. The point of the chain is to recover structure that no single pairwise
number contains.
"""
import json
import numpy as np

d = np.load('eval/real/windows.npz')
X, windows = d['X'], d['windows']
n = len(X)
print(f'{n} windows')

def refine(A, p_percentile=0.95, blur=1.0):
    A = A.copy()
    np.fill_diagonal(A, A.max())
    # 1. Temporal smoothing: adjacent windows are usually the same person, so a
    #    little blur along the diagonal suppresses per-window noise.
    if blur > 0:
        from scipy.ndimage import gaussian_filter  # noqa
        A = gaussian_filter(A, sigma=blur)
    # 2. Row thresholding: keep each row's strongest links, crush the rest.
    #    This is what stops a window's 200 weak similarities from outvoting its
    #    5 real ones.
    thresh = np.quantile(A, p_percentile, axis=1, keepdims=True)
    A = np.where(A < thresh, A * 0.01, A)
    # 3. Symmetrize, then diffuse: Y·Yᵀ makes two windows similar when they are
    #    similar to the same OTHER windows, which is far more robust than
    #    whether they resemble each other directly.
    A = np.maximum(A, A.T)
    A = A @ A.T
    # 4. Row-max normalize so no window dominates the spectrum by being loud.
    A = A / np.maximum(A.max(axis=1, keepdims=True), 1e-12)
    return np.maximum(A, A.T)

def spectral(A, max_speakers=15):
    deg = A.sum(axis=1)
    Dinv = np.diag(1.0 / np.sqrt(np.maximum(deg, 1e-12)))
    L = np.eye(len(A)) - Dinv @ A @ Dinv
    vals, vecs = np.linalg.eigh(L)
    # Eigengap: the biggest jump in the smallest eigenvalues is the number of
    # well-separated components. Reading K off the data rather than assuming it
    # is the whole point -- nothing here is told there were seven people.
    k_range = np.arange(1, min(max_speakers, len(vals) - 1) + 1)
    gaps = vals[k_range] - vals[k_range - 1]
    k = int(k_range[int(np.argmax(gaps))])
    U = vecs[:, :k]
    U = U / np.maximum(np.linalg.norm(U, axis=1, keepdims=True), 1e-12)
    return k, U, vals

def kmeans(U, k, seed=0, iters=100):
    rng = np.random.default_rng(seed)
    centres = U[rng.choice(len(U), k, replace=False)]
    labels = np.zeros(len(U), dtype=int)
    for _ in range(iters):
        d2 = ((U[:, None, :] - centres[None, :, :]) ** 2).sum(axis=2)
        new = d2.argmin(axis=1)
        if (new == labels).all(): break
        labels = new
        for j in range(k):
            if (labels == j).any(): centres[j] = U[labels == j].mean(axis=0)
    return labels

A = X @ X.T
for p in (0.90, 0.95, 0.98):
    R = refine(A, p_percentile=p)
    k, U, vals = spectral(R)
    labels = kmeans(U, k)
    sizes = np.bincount(labels)
    secs = [float(sum(windows[labels == j][:, 1] - windows[labels == j][:, 0])) for j in range(k)]
    print(f'  p={p}  K={k}  cluster speech (s): {[round(s) for s in sorted(secs, reverse=True)]}')
    np.savez(f'eval/real/labels-p{int(p*100)}.npz', labels=labels, windows=windows, k=k)
