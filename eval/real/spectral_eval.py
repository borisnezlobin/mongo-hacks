"""Does spectral clustering separate the people we can identify with certainty?

Diagnostic, not tuning: sweeping K asks whether the representation contains the
distinction at all. If no K separates Boris from Vova, no amount of choosing K
better will help and the embedding is the ceiling.
"""
import numpy as np
from scipy.ndimage import gaussian_filter

d = np.load('eval/real/windows.npz')
X, windows = d['X'], d['windows']

ANCHORS = [
    ('boris', 18.558, 19.808), ('boris', 33.9, 35.1), ('boris', 1633.0, 1636.5),
    ('vova', 24.308, 25.908), ('vova', 28.608, 29.458), ('vova', 55.5, 60.0),
    ('clara', 1809.4, 1811.0), ('clara', 1813.2, 1817.0),
    ('dhruv', 2316.78, 2317.03), ('dhruv', 2318.53, 2319.03),
]

def refine(A, p=0.95, blur=1.0):
    A = A.copy(); np.fill_diagonal(A, A.max())
    if blur: A = gaussian_filter(A, sigma=blur)
    A = np.where(A < np.quantile(A, p, axis=1, keepdims=True), A * 0.01, A)
    A = np.maximum(A, A.T); A = A @ A.T
    return np.maximum(A / np.maximum(A.max(axis=1, keepdims=True), 1e-12), 0)

def embed_spectral(A, k):
    deg = A.sum(axis=1); Dinv = np.diag(1/np.sqrt(np.maximum(deg,1e-12)))
    L = np.eye(len(A)) - Dinv @ A @ Dinv
    vals, vecs = np.linalg.eigh(L)
    U = vecs[:, :k]
    return U / np.maximum(np.linalg.norm(U, axis=1, keepdims=True), 1e-12)

def kmeans(U, k, seed=0):
    rng = np.random.default_rng(seed); C = U[rng.choice(len(U), k, replace=False)]
    lab = np.zeros(len(U), int)
    for _ in range(120):
        new = ((U[:,None,:]-C[None,:,:])**2).sum(2).argmin(1)
        if (new==lab).all(): break
        lab = new
        for j in range(k):
            if (lab==j).any(): C[j] = U[lab==j].mean(0)
    return lab

def label_at(labels, a, b):
    hit = [(min(b,w1)-max(a,w0), labels[i]) for i,(w0,w1) in enumerate(windows) if min(b,w1)>max(a,w0)]
    if not hit: return None
    best = {}
    for ov, l in hit: best[l] = best.get(l,0)+ov
    return max(best, key=best.get)

A = X @ X.T
R = refine(A)
print(' K  | anchors resolved | same-person consistent | distinct people kept apart')
for k in range(2, 13):
    U = embed_spectral(R, k); labels = kmeans(U, k)
    got = [(p, label_at(labels, a, b)) for p, a, b in ANCHORS]
    resolved = [(p,l) for p,l in got if l is not None]
    byperson = {}
    for p,l in resolved: byperson.setdefault(p, set()).add(l)
    consistent = sum(1 for p,s in byperson.items() if len(s)==1)
    allsets = list(byperson.items())
    apart = sum(1 for i in range(len(allsets)) for j in range(i+1,len(allsets))
                if not (allsets[i][1] & allsets[j][1]))
    pairs = len(allsets)*(len(allsets)-1)//2
    print(f' {k:2d} |      {len(resolved)}/10       |        {consistent}/{len(byperson)}          |        {apart}/{pairs}')
