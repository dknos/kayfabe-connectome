"""louvain-seeded@1 — deterministic Louvain community detection + degrees.

Edge weight = 2*sameSide + opposed + 0.25*brOpposed.
Fixed seed 1963; node visit order is a seeded shuffle per pass; ties in
modularity gain break toward the smallest community id. Final communities are
renumbered by (size desc, smallest member node index asc).
"""

from __future__ import annotations

import random

LOUVAIN_SEED = 1963
EDGE_WEIGHT = (2.0, 1.0, 0.25)  # sameSide, opposed, brOpposed


def pair_weight(same: int, opposed: int, br: int) -> float:
    return EDGE_WEIGHT[0] * same + EDGE_WEIGHT[1] * opposed + EDGE_WEIGHT[2] * br


def _one_level(adj, self_w, nodes, rng):
    """One Louvain level: local moving until no improvement.

    adj: {u: {v: w}} (u != v), self_w: {u: internal weight}, nodes: sorted ids.
    Returns (node -> community, improved: bool).
    """
    ki = {u: sum(adj[u].values()) + 2.0 * self_w.get(u, 0.0) for u in nodes}
    m2 = sum(ki.values())
    if m2 <= 0:
        return {u: u for u in nodes}, False

    comm = {u: u for u in nodes}
    tot = {u: ki[u] for u in nodes}
    improved_any = False

    while True:
        moved = 0
        order = list(nodes)
        rng.shuffle(order)
        for u in order:
            cu = comm[u]
            # weights from u to neighboring communities
            neigh: dict[int, float] = {}
            for v, w in adj[u].items():
                cv = comm[v]
                neigh[cv] = neigh.get(cv, 0.0) + w
            # remove u from its community
            tot[cu] -= ki[u]
            base = neigh.get(cu, 0.0)
            best_c, best_gain = cu, base - tot[cu] * ki[u] / m2
            for c in sorted(neigh):
                if c == cu:
                    continue
                gain = neigh[c] - tot[c] * ki[u] / m2
                if gain > best_gain + 1e-12 or (
                    abs(gain - best_gain) <= 1e-12 and c < best_c
                ):
                    best_gain, best_c = gain, c
            comm[u] = best_c
            tot[best_c] += ki[u]
            if best_c != cu:
                moved += 1
        if moved == 0:
            break
        improved_any = True
    return comm, improved_any


def louvain(edges: dict[tuple[int, int], float], seed: int = LOUVAIN_SEED) -> dict[int, int]:
    """edges: {(u, v): weight} with u < v, integer node ids.

    Returns {node id -> community id} with community ids renumbered
    0..K-1 by (size desc, smallest member asc). Deterministic.
    """
    nodes = sorted({n for e in edges for n in e})
    if not nodes:
        return {}
    adj: dict[int, dict[int, float]] = {u: {} for u in nodes}
    for (u, v), w in edges.items():
        if u == v or w <= 0:
            continue
        adj[u][v] = adj[u].get(v, 0.0) + w
        adj[v][u] = adj[v].get(u, 0.0) + w
    self_w: dict[int, float] = {}

    rng = random.Random(seed)
    # node -> community in the ORIGINAL graph
    mapping = {u: u for u in nodes}

    while True:
        level_nodes = sorted(adj)
        comm, improved = _one_level(adj, self_w, level_nodes, rng)
        if not improved:
            break
        # apply to original mapping
        mapping = {u: comm[mapping[u]] for u in mapping}
        # aggregate graph
        new_self: dict[int, float] = {}
        new_adj: dict[int, dict[int, float]] = {}
        for u in level_nodes:
            cu = comm[u]
            new_adj.setdefault(cu, {})
            new_self[cu] = new_self.get(cu, 0.0) + self_w.get(u, 0.0)
        for u in level_nodes:
            cu = comm[u]
            for v, w in adj[u].items():
                if u < v:
                    cv = comm[v]
                    if cu == cv:
                        new_self[cu] = new_self.get(cu, 0.0) + w
                    else:
                        new_adj[cu][cv] = new_adj[cu].get(cv, 0.0) + w
                        new_adj[cv][cu] = new_adj[cv].get(cu, 0.0) + w
        if len(new_adj) == len(adj):
            break
        adj, self_w = new_adj, new_self

    # renumber deterministically: size desc, then smallest member node id
    groups: dict[int, list[int]] = {}
    for u in sorted(mapping):
        groups.setdefault(mapping[u], []).append(u)
    ordered = sorted(groups.values(), key=lambda g: (-len(g), min(g)))
    out: dict[int, int] = {}
    for cid, members in enumerate(ordered):
        for u in members:
            out[u] = cid
    return out


def degrees(edges: dict[tuple[int, int], float]) -> dict[int, int]:
    """Distinct-neighbor count per node."""
    deg: dict[int, int] = {}
    for u, v in edges:
        deg[u] = deg.get(u, 0) + 1
        deg[v] = deg.get(v, 0) + 1
    return deg
