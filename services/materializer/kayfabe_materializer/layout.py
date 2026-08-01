"""global-layout@3 — deterministic 3D layout.

* Communities sit on a golden-angle (Fibonacci) spiral sphere; the shell
  radius grows with community size rank (largest community innermost).
* Members relax inside their community via a small seeded O(n^2) repulsion
  (iteration budget scales down for big communities), plus slight z-jitter
  from the seeded rng.
* The 6 promotions are anchor nodes on an outer ring; titles cluster near
  their promotion's anchor on a golden-angle disc.
* Everything is normalized to ~[-1,1]^3 with a single uniform scale.
* NaN checks are mandatory and fatal.
"""

from __future__ import annotations

import math
import random

LAYOUT_SEED = 1963
GOLDEN_ANGLE = math.pi * (3.0 - math.sqrt(5.0))
_RELAX_BUDGET = 8_000_000  # pair-interactions budget per community


def _fib_sphere(i: int, n: int) -> tuple[float, float, float]:
    """i-th of n points on a unit sphere via the golden-angle spiral."""
    if n <= 1:
        return (0.0, 1.0, 0.0)
    y = 1.0 - 2.0 * (i + 0.5) / n
    r = math.sqrt(max(0.0, 1.0 - y * y))
    th = GOLDEN_ANGLE * i
    return (r * math.cos(th), y, r * math.sin(th))


def _relax(points: list[list[float]], center: tuple[float, float, float], radius: float,
           rng: random.Random) -> None:
    """Seeded O(n^2) repulsion inside a soft sphere around center."""
    n = len(points)
    if n < 2:
        return
    if n * n > _RELAX_BUDGET:
        # Oversized community: the golden-angle shell seeding is already
        # uniform; a single O(n^2) pass would cost minutes in pure Python
        # for no visible gain. Keep only the z-jitter below.
        for p in points:
            p[2] += (rng.random() - 0.5) * 0.5 * radius
        return
    iters = max(1, min(40, _RELAX_BUDGET // (n * n)))
    min_sep = radius * 1.6 / math.sqrt(n)
    for _ in range(iters):
        for i in range(n):
            pi = points[i]
            for j in range(i + 1, n):
                pj = points[j]
                dx = pi[0] - pj[0]
                dy = pi[1] - pj[1]
                dz = pi[2] - pj[2]
                d2 = dx * dx + dy * dy + dz * dz
                if d2 >= min_sep * min_sep:
                    continue
                d = math.sqrt(d2)
                if d < 1e-9:
                    # deterministic tiny separation for coincident points
                    dx, dy, dz, d = 1e-6 * (i - j), 1e-6, 0.0, 1e-6
                push = 0.5 * (min_sep - d) / d
                pi[0] += dx * push
                pi[1] += dy * push
                pi[2] += dz * push
                pj[0] -= dx * push
                pj[1] -= dy * push
                pj[2] -= dz * push
        # soft-clamp back into the community sphere
        for p in points:
            ox = p[0] - center[0]
            oy = p[1] - center[1]
            oz = p[2] - center[2]
            d = math.sqrt(ox * ox + oy * oy + oz * oz)
            lim = radius * 1.4
            if d > lim:
                f = lim / d
                p[0] = center[0] + ox * f
                p[1] = center[1] + oy * f
                p[2] = center[2] + oz * f
    for p in points:
        p[2] += (rng.random() - 0.5) * 0.5 * radius  # z volume: lobes, not discs


def compute_layout(
    person_indices: list[int],
    communities: dict[int, int],
    promo_ids: list[int],
    title_promos: list[tuple[int, int]],
) -> dict:
    """Compute positions for every node.

    person_indices : node indices of person nodes (ascending)
    communities    : node index -> community id (-1 = unclustered)
    promo_ids      : promotion node indices, in node order (<= 6)
    title_promos   : [(title node index, promotion node index)] in node order
    Returns {"pos": {node index: (x, y, z)}}, normalized to ~[-1,1]^3.
    """
    pos: dict[int, list[float]] = {}

    groups: dict[int, list[int]] = {}
    for idx in person_indices:
        groups.setdefault(communities.get(idx, -1), []).append(idx)

    cids = sorted(c for c in groups if c >= 0)
    k = len(cids)
    for rank, cid in enumerate(cids):  # cid order == size rank (renumbered)
        members = sorted(groups[cid])
        size = len(members)
        # v3: the merged corpus's largest community holds ~9k people (v2's held
        # ~2k, capped 0.58). Two rules changed together:
        #  * radius keeps scaling with sqrt(size) (cap 1.05) so dense lobes get
        #    volume instead of integrating into a white plateau, and
        #  * shell distance grows WITH radius — a giant lobe centered near the
        #    origin engulfs the whole scene, so the big lobes ring a hollow
        #    core (brain lobes, not a sun) and small communities fill between.
        radius = min(1.05, 0.03 + 0.0125 * math.sqrt(size))
        shell = 0.22 + 1.12 * radius + (0.42 * rank / (k - 1) if k > 1 else 0.0)
        dx, dy, dz = _fib_sphere(rank, k)
        center = (dx * shell, dy * shell, dz * shell)
        rng = random.Random(LAYOUT_SEED * 1_000_003 + cid)
        pts = []
        for j in range(size):
            sx, sy, sz = _fib_sphere(j, size)
            r_in = radius * (0.4 + 0.6 * ((j + 0.5) / size) ** (1.0 / 3.0))
            pts.append([center[0] + sx * r_in, center[1] + sy * r_in, center[2] + sz * r_in])
        _relax(pts, center, radius, rng)
        for m, p in zip(members, pts):
            pos[m] = p

    # unclustered persons: deterministic outer shell
    loners = sorted(groups.get(-1, []))
    for j, idx in enumerate(loners):
        sx, sy, sz = _fib_sphere(j, len(loners))
        pos[idx] = [sx * 1.02, sy * 1.02, sz * 1.02]

    # promotions: outer ring
    ring_r = 1.12
    np = max(1, len(promo_ids))
    anchors: dict[int, tuple[float, float, float]] = {}
    for j, idx in enumerate(promo_ids):
        th = 2.0 * math.pi * j / np
        a = (ring_r * math.cos(th), ring_r * math.sin(th), 0.0)
        anchors[idx] = a
        pos[idx] = list(a)

    # titles: golden-angle disc near their promotion anchor
    rng_t = random.Random(LAYOUT_SEED * 7_777_777)
    per_promo_count: dict[int, int] = {}
    for t_idx, p_idx in title_promos:
        j = per_promo_count.get(p_idx, 0)
        per_promo_count[p_idx] = j + 1
        ax, ay, az = anchors.get(p_idx, (0.0, 0.0, 0.0))
        r = 0.035 * math.sqrt(j + 1)
        th = GOLDEN_ANGLE * j
        pos[t_idx] = [
            ax * 0.93 + r * math.cos(th),
            ay * 0.93 + r * math.sin(th),
            az + (rng_t.random() - 0.5) * 0.06,
        ]

    # normalize with one uniform scale; round; NaN checks mandatory
    max_abs = 0.0
    for p in pos.values():
        for c in p:
            if not math.isfinite(c):
                raise ValueError("non-finite coordinate before normalization")
            max_abs = max(max_abs, abs(c))
    scale = 0.98 / max_abs if max_abs > 0 else 1.0
    out: dict[int, tuple[float, float, float]] = {}
    for idx, p in pos.items():
        q = []
        for c in p:
            v = round(c * scale, 4)
            if not math.isfinite(v):
                raise ValueError("non-finite coordinate after normalization")
            q.append(0.0 if v == 0 else v)
        out[idx] = (q[0], q[1], q[2])
    return {"pos": out}
