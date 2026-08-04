"""alcubierre-bridge-lut@1 — observer-relative warp optics for the Spacetime lens.

Physics, not decoration: the table is built by integrating actual null
geodesics through the Alcubierre metric written in bubble-comoving ("river")
coordinates. With x' = x - v t the line element becomes

    ds^2 = -dt^2 + (dx' + beta(r) dt)^2 + dy^2 + dz^2,
    beta(r) = v * (1 - f(r)),
    f(r)    = [tanh(sigma*(r+R)) - tanh(sigma*(r-R))] / (2*tanh(sigma*R)),

which is stationary in these coordinates, so k_t is conserved along null
geodesics. The bridge observer sits at the bubble centre (beta = 0, locally
Minkowski, u = d/dt). Far-field stars ride the river (u_star = (1, -v, 0, 0)),
timelike for EVERY v including superluminal — the river form never lets a
local frame exceed c, which is what makes warp 9 integrable at all.

For each apparent polar angle theta_app (measured from the direction of
travel) a PAST-directed ray is walked outward from the observer; the far-field
asymptote gives the source angle, and

    delta = omega_obs / omega_emit = 1 / (1 + v * k_x)

gives the frequency ratio (k_x = lowered far-field momentum). The map is then
inverted onto a uniform theta_src grid per warp-speed row, and magnification
comes from the solid-angle Jacobian of that inversion. Rays whose delta
collapses toward zero — photons that cannot catch a superluminal bubble — ARE
the apparent horizon: the visibility channel falls out of the integration
rather than being authored.

Corpus data never enters this module. Physics changes apparent geometry only;
what the stars MEAN stays with the corpus (see spacetime_project.py).

This follows arXiv:1107.5650 (Mueller & Weiskopf, Gen. Relativ. Gravit. 44:509,
2012) — the same architecture as their JRelStarFlight renderer: a precomputed
(source angle x log-sampled warp speed) table applied in shaders, bridge
observer only. Their paper anchors this implementation with closed forms that
the validator asserts against the finished table:
  * xi = 90 deg is an exact fixed point — no aberration, no shift, every v
    (their Appendix C).
  * delta = omega_obs / omega_emit = 1 + v*cos(phi_src) with gamma REPLACED
    BY 1 (proper time on the bridge equals coordinate time — the warp drive's
    whole selling point), which is why v > c needs no special casing.
  * The invisible rear cone for v > c is phi_src > arccos(-1/v): 120 deg at
    2c, 96.4 deg at warp 9. It emerges from the integration as delta -> 0.
Divergences from the paper, on purpose: bubble R=1 sigma=8 (thin wall; they
plot R=2 sigma=1 — far-field closed forms are wall-independent), a v=0
identity row at the bottom of the table (for unwarp blending), and
magnification from the solid-angle Jacobian of the inversion rather than the
full Sachs/Jacobi bundle — the bundle reaches 1e-7 rear dimming, which this
table's +-3-decade clamp would flatten anyway.

Sign conventions that were each worth a debugging session:
  * The comoving metric is stationary but NOT static (g_tx != 0). Launching a
    future-directed ray outward and relabelling it models a bubble moving the
    OPPOSITE way — the forward sky comes out redshifted. Past-directed
    integration (h < 0, spatial momentum away from the source) is mandatory.
  * theta_src is measured in the LAB (static-star) frame, not the comoving
    frame — that is the frame the semantic source layout lives in, and it is
    what makes xi=90 -> phi=90 exact. In the flat far field the lab-frame
    observer->source direction is simply the NEGATED spatial momentum -(k_x,
    k_y): lab x = x' + v t, and the v t term cancels the river drift exactly.
  * Magnification is dOmega_apparent / dOmega_source: M > 1 means the source
    occupies more apparent sky and a point source brightens by that factor.

Determinism: fixed-step-policy RK4, fixed grids, no wall clock, no randomness.
Two runs produce byte-identical tables. Stdlib only.

Wire format (documented byte layout, consumed by packages/spacetime-renderer):
  lut/bridge.f16.bin   — width*height*4 IEEE 754 half floats, little-endian,
                          row-major from v-row 0 (v=0) upward, R,G,B,A
                          interleaved per texel.
  lut/bridge-rgba8.bin — same values quantised round(x*255) to one byte each.
  Channels (both files store the SAME normalised [0,1] encoding):
    R = theta_apparent / pi
    G = (clamp(ln delta, -LOG_DELTA_MAX, +LOG_DELTA_MAX) + LOG_DELTA_MAX)
        / (2*LOG_DELTA_MAX)                      — signed log frequency shift
    B = (clamp(log10 M, -LOG_MAG_MAX, +LOG_MAG_MAX) + LOG_MAG_MAX)
        / (2*LOG_MAG_MAX)                        — signed log magnification
    A = visibility (1 documented-visible, 0 behind the apparent horizon)
  Texel (s, t): s in [0,1] maps theta_src = s*pi; t maps warp speed
  v = (VMAX+1)**t - 1 (logarithmic speed sampling, v=0 at t=0, VMAX at t=1).
"""

from __future__ import annotations

import math
import struct

# --------------------------------------------------------------- parameters

BUBBLE_R = 1.0        # bubble radius; everything scales with it
BUBBLE_SIGMA = 8.0    # wall sharpness (paper regime: thin wall, smooth tanh)
STEP = 0.02           # base RK4 affine step, in units of BUBBLE_R
MAX_STEPS = 6000      # rays that never escape the wall region are horizon rays
VMAX = 9.0            # top warp-speed row

# Output grid (the shader-facing table).
LUT_WIDTH = 4096      # theta_src samples
LUT_HEIGHT = 256      # warp-speed rows
# Integration grid (what is actually traced; the output grid interpolates it).
TRACE_THETA = 768
TRACE_V = 64

LOG_DELTA_MAX = 6.0   # ln(delta) clamp — e^6 ≈ 403x shift saturates the halo
LOG_MAG_MAX = 3.0     # log10(M) clamp — 1000x magnification saturates

DELTA_FLOOR = 1e-6    # below this the photon is horizon-trapped in practice


def shape_f(r: float, R: float = BUBBLE_R, sigma: float = BUBBLE_SIGMA) -> float:
    """Alcubierre top-hat shape function: 1 at the centre, 0 far away."""
    if sigma * (r - R) > 40.0:
        return 0.0
    return (math.tanh(sigma * (r + R)) - math.tanh(sigma * (r - R))) / (
        2.0 * math.tanh(sigma * R)
    )


def shape_df(r: float, R: float = BUBBLE_R, sigma: float = BUBBLE_SIGMA) -> float:
    """d f / d r, analytic."""
    if sigma * (r - R) > 40.0:
        return 0.0
    a = math.cosh(sigma * (r + R))
    b = math.cosh(sigma * (r - R))
    return (sigma / (2.0 * math.tanh(sigma * R))) * (1.0 / (a * a) - 1.0 / (b * b))


def warp_speed_of_row(t: float, vmax: float = VMAX) -> float:
    """Logarithmic speed sampling: v(0)=0, v(1)=vmax, dense near luminal."""
    return (vmax + 1.0) ** t - 1.0


# ------------------------------------------------- null geodesic integration
#
# Hamiltonian H = 1/2 [ -k_t^2 + 2 beta k_t k_x + (1-beta^2) k_x^2 + k_y^2 ]
# in the (x, y) plane — the problem is axisymmetric about the travel axis, so
# 2D covers the full sky. Lowered momenta throughout; k_t = -1 (E = 1).


def _rhs(state: tuple, v: float) -> tuple:
    x, y, kx, ky = state
    r = math.hypot(x, y)
    beta = v * (1.0 - shape_f(r))
    if r > 1e-12:
        dbeta_dr = -v * shape_df(r)
        dbx = dbeta_dr * (x / r)
        dby = dbeta_dr * (y / r)
    else:
        dbx = dby = 0.0
    kt = -1.0
    common = kt * kx - beta * kx * kx
    return (
        beta * kt + (1.0 - beta * beta) * kx,
        ky,
        -dbx * common,
        -dby * common,
    )


def _rk4_step(state: tuple, v: float, h: float) -> tuple:
    k1 = _rhs(state, v)
    s2 = tuple(state[i] + 0.5 * h * k1[i] for i in range(4))
    k2 = _rhs(s2, v)
    s3 = tuple(state[i] + 0.5 * h * k2[i] for i in range(4))
    k3 = _rhs(s3, v)
    s4 = tuple(state[i] + h * k3[i] for i in range(4))
    k4 = _rhs(s4, v)
    return tuple(
        state[i] + (h / 6.0) * (k1[i] + 2.0 * k2[i] + 2.0 * k3[i] + k4[i])
        for i in range(4)
    )


def trace_ray(theta_app: float, v: float) -> tuple:
    """One past-directed ray from the bridge observer.

    Returns (theta_src, delta, escaped). theta_src is the asymptotic
    observer->source direction folded to [0, pi]; delta = omega_obs/omega_emit;
    escaped False means horizon-trapped (never reached the flat region).
    """
    # Received photon: future-directed, E=1, spatial momentum AWAY from the
    # source at the flat centre. Negative affine steps walk it into its past.
    state = (0.0, 0.0, -math.cos(theta_app), -math.sin(theta_app))
    # Outside this radius f and df are < ~1e-5: flat metric, straight lines.
    flat_r = BUBBLE_R + 8.0 / BUBBLE_SIGMA
    for _ in range(MAX_STEPS):
        # Momentum-scaled step: near the wall at high v the momenta amplify,
        # and a fixed affine step would overshoot the whole curved region.
        kmag = abs(state[2]) + abs(state[3])
        h = -STEP / max(1.0, kmag)
        state = _rk4_step(state, v, h)
        r = math.hypot(state[0], state[1])
        if r >= flat_r:
            kx, ky = state[2], state[3]
            if math.hypot(kx, ky) < 1e-12:
                return (theta_app, 0.0, False)
            # LAB-frame observer->source direction: in the static far field the
            # photon momentum is (kx, ky) pointing source->observer, so the
            # source sits along -(kx, ky). Folded to [0, pi] by axisymmetry.
            theta_src = math.atan2(abs(ky), -kx)
            # omega_emit = -k . u_star, u_star = (1, -v, 0, 0), lowered k:
            omega_emit = 1.0 + v * kx
            if omega_emit <= 1e-9:
                return (theta_src, 0.0, False)
            # By construction delta == 1 + v*cos(theta_src): the closed form
            # the validator asserts (paper Fig. 5 endpoints, <1% there).
            return (theta_src, 1.0 / omega_emit, True)
    return (theta_app, 0.0, False)


def build_row(v: float, n_trace: int = TRACE_THETA, n_out: int = LUT_WIDTH) -> tuple:
    """One warp-speed row on a uniform theta_src grid of n_out samples.

    Returns (apparent, delta, magnification, visibility) lists. Source angles
    outside the visible principal branch keep visibility 0 — that IS the
    apparent horizon, never an authored cutoff.
    """
    samples = []
    for i in range(n_trace):
        ta = math.pi * i / (n_trace - 1)
        ts, delta, escaped = trace_ray(ta, v)
        if escaped and delta > DELTA_FLOOR:
            samples.append((ts, ta, delta))

    out_app = [0.0] * n_out
    out_delta = [1.0] * n_out
    out_mag = [1.0] * n_out
    out_vis = [0.0] * n_out
    if len(samples) < 4:
        return out_app, out_delta, out_mag, out_vis

    # Principal image branch: keep theta_src strictly increasing in theta_app
    # so the inversion is single-valued. Fold-backs (secondary images) are
    # dropped — one apparent position per source, the strongest reading.
    samples.sort(key=lambda s: s[1])
    principal = [samples[0]]
    for s in samples[1:]:
        if s[0] > principal[-1][0] + 1e-9:
            principal.append(s)
    if len(principal) < 4:
        return out_app, out_delta, out_mag, out_vis

    src = [p[0] for p in principal]
    app = [p[1] for p in principal]
    dlt = [p[2] for p in principal]

    lo_src, hi_src = src[0], src[-1]
    j = 0
    for i in range(n_out):
        ts = math.pi * i / (n_out - 1)
        if ts < lo_src or ts > hi_src:
            continue
        while j < len(src) - 2 and src[j + 1] < ts:
            j += 1
        span = src[j + 1] - src[j]
        w = 0.0 if span <= 0 else (ts - src[j]) / span
        out_app[i] = app[j] + w * (app[j + 1] - app[j])
        out_delta[i] = dlt[j] * (1.0 - w) + dlt[j + 1] * w
        out_vis[i] = 1.0

    # Magnification: M = dOmega_apparent / dOmega_source, central differences
    # over visible spans on the output grid.
    for i in range(n_out):
        if out_vis[i] == 0.0:
            continue
        i0 = max(0, i - 1)
        i1 = min(n_out - 1, i + 1)
        if out_vis[i0] == 0.0 or out_vis[i1] == 0.0 or i1 == i0:
            continue
        ts0 = math.pi * i0 / (n_out - 1)
        ts1 = math.pi * i1 / (n_out - 1)
        dts = ts1 - ts0
        dta = out_app[i1] - out_app[i0]
        ts = math.pi * i / (n_out - 1)
        s_ta = max(math.sin(out_app[i]), 1e-6)
        s_ts = max(math.sin(ts), 1e-6)
        if abs(dts) > 1e-12:
            out_mag[i] = max(1e-4, min(1e4, (s_ta * dta) / (s_ts * dts)))
    return out_app, out_delta, out_mag, out_vis


# ------------------------------------------------------------------- baking


def encode_texel(theta_app: float, delta: float, mag: float, vis: float) -> tuple:
    """Physical quantities -> the normalised [0,1] channel encoding."""
    r = min(1.0, max(0.0, theta_app / math.pi))
    ln_d = math.log(delta) if delta > 0.0 else -LOG_DELTA_MAX
    g = (min(LOG_DELTA_MAX, max(-LOG_DELTA_MAX, ln_d)) + LOG_DELTA_MAX) / (2.0 * LOG_DELTA_MAX)
    lg_m = math.log10(mag) if mag > 0.0 else 0.0
    b = (min(LOG_MAG_MAX, max(-LOG_MAG_MAX, lg_m)) + LOG_MAG_MAX) / (2.0 * LOG_MAG_MAX)
    return r, g, b, min(1.0, max(0.0, vis))


def decode_texel(r: float, g: float, b: float, a: float) -> tuple:
    """Inverse of encode_texel — the validator round-trips through this."""
    theta_app = r * math.pi
    delta = math.exp(g * 2.0 * LOG_DELTA_MAX - LOG_DELTA_MAX)
    mag = 10.0 ** (b * 2.0 * LOG_MAG_MAX - LOG_MAG_MAX)
    return theta_app, delta, mag, a


def build_lut(progress=None) -> list:
    """The full table as LUT_HEIGHT rows of LUT_WIDTH (r,g,b,a) texel tuples.

    TRACE_V rows are integrated; the LUT_HEIGHT output rows interpolate
    between them linearly in row space (the v grid is already log-spaced, so
    row-space interpolation is log-space interpolation in v).
    """
    traced = []
    for i in range(TRACE_V):
        v = warp_speed_of_row(i / (TRACE_V - 1))
        traced.append(build_row(v))
        if progress:
            progress(i + 1, TRACE_V, v)

    rows = []
    for j in range(LUT_HEIGHT):
        t = j / (LUT_HEIGHT - 1) * (TRACE_V - 1)
        j0 = min(TRACE_V - 2, int(t))
        w = t - j0
        a_app, a_dlt, a_mag, a_vis = traced[j0]
        b_app, b_dlt, b_mag, b_vis = traced[j0 + 1]
        row = []
        for i in range(LUT_WIDTH):
            row.append(encode_texel(
                a_app[i] * (1.0 - w) + b_app[i] * w,
                a_dlt[i] * (1.0 - w) + b_dlt[i] * w,
                a_mag[i] * (1.0 - w) + b_mag[i] * w,
                a_vis[i] * (1.0 - w) + b_vis[i] * w,
            ))
        rows.append(row)
    return rows


def pack_f16(rows: list) -> bytes:
    """Half-float file: row-major, R,G,B,A interleaved, little-endian."""
    pack = struct.Struct("<4e").pack
    return b"".join(pack(*texel) for row in rows for texel in row)


def pack_rgba8(rows: list) -> bytes:
    """Quantised fallback: round(x*255) per channel."""
    out = bytearray(LUT_WIDTH * LUT_HEIGHT * 4)
    n = 0
    for row in rows:
        for r, g, b, a in row:
            out[n] = round(r * 255.0)
            out[n + 1] = round(g * 255.0)
            out[n + 2] = round(b * 255.0)
            out[n + 3] = round(a * 255.0)
            n += 4
    return bytes(out)


def lut_meta() -> dict:
    """The manifest block a consumer needs to sample the table correctly."""
    return {
        "algorithm": "alcubierre-bridge-lut@1",
        "width": LUT_WIDTH,
        "height": LUT_HEIGHT,
        "integration_grid": {"theta": TRACE_THETA, "v": TRACE_V},
        "bubble": {"R": BUBBLE_R, "sigma": BUBBLE_SIGMA},
        "v_max": VMAX,
        "v_of_row": "v = (v_max+1)**t - 1, t = row/(height-1)",
        "channels": {
            "R": "theta_apparent / pi",
            "G": f"(clamp(ln delta, ±{LOG_DELTA_MAX}) + {LOG_DELTA_MAX}) / {2 * LOG_DELTA_MAX}",
            "B": f"(clamp(log10 magnification, ±{LOG_MAG_MAX}) + {LOG_MAG_MAX}) / {2 * LOG_MAG_MAX}",
            "A": "visibility / apparent-horizon mask",
        },
        "files": {
            "bridge.f16.bin": "width*height*4 little-endian IEEE half floats",
            "bridge-rgba8.bin": "same values quantised to bytes, round(x*255)",
        },
    }


if __name__ == "__main__":
    # Standalone bake for inspection; the projection normally drives this.
    rows = build_lut(progress=lambda i, n, v: print(f"  lut row {i}/{n} v={v:.2f}"))
    print(f"packed f16: {len(pack_f16(rows))} bytes; rgba8: {len(pack_rgba8(rows))} bytes")
