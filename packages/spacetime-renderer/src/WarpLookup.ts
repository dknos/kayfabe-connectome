/**
 * The bridge-observer warp table: GPU texture + CPU sampler.
 *
 * Two files ship from the materializer (byte layouts in spacetime_lut.py and
 * docs/SPACETIME_WARP_FIELD.md):
 *
 *   bridge.f16.bin    — half-float, feeds the CPU sampler. Event beads are
 *                       positioned on the CPU so picking is exact, and the
 *                       unwarp readout quotes numbers from here.
 *   bridge-rgba8.bin  — the SAME values quantised to bytes, feeds the GPU
 *                       texture. Chosen over half-float for the texture on
 *                       purpose: UNSIGNED_BYTE + linear filtering works on
 *                       every WebGL2 stack including SwiftShader, while
 *                       half-float linear filtering needs an extension this
 *                       repository has no headless way to verify. 8 bits per
 *                       channel is ~0.7 deg of apparent angle — invisible at
 *                       halo scale, and the CPU path keeps full precision.
 *
 * Both decode through the same lutDecode() twin as the Python encoder.
 */
import {
  ClampToEdgeWrapping, DataTexture, LinearFilter, RGBAFormat, UnsignedByteType,
} from "three";
import { lutDecode, lutRowOfSpeed, type LutSample } from "./types";

/** IEEE 754 half -> number. The three f16 helpers are renderer-internal, so
 *  the decode lives here where the tests can reach it. */
export function halfToFloat(h: number): number {
  const sign = (h & 0x8000) ? -1 : 1;
  const exp = (h >> 10) & 0x1f;
  const frac = h & 0x3ff;
  if (exp === 0) return sign * frac * Math.pow(2, -24);
  if (exp === 31) return frac ? Number.NaN : sign * Infinity;
  return sign * (1 + frac / 1024) * Math.pow(2, exp - 15);
}

export class WarpLookup {
  readonly width: number;
  readonly height: number;
  /** full-precision channels, row-major RGBA */
  private readonly data: Float32Array;
  /** the quantised texture the shaders sample */
  readonly texture: DataTexture;

  constructor(f16: ArrayBuffer, rgba8: ArrayBuffer, width: number, height: number) {
    this.width = width;
    this.height = height;
    if (f16.byteLength !== width * height * 8) {
      throw new Error(`warp lut f16: ${f16.byteLength} bytes for ${width}x${height}`);
    }
    if (rgba8.byteLength !== width * height * 4) {
      throw new Error(`warp lut rgba8: ${rgba8.byteLength} bytes for ${width}x${height}`);
    }
    const raw = new Uint16Array(f16);
    this.data = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) this.data[i] = halfToFloat(raw[i]!);

    this.texture = new DataTexture(
      new Uint8Array(rgba8), width, height, RGBAFormat, UnsignedByteType,
    );
    this.texture.magFilter = LinearFilter;
    this.texture.minFilter = LinearFilter;
    this.texture.wrapS = ClampToEdgeWrapping;
    this.texture.wrapT = ClampToEdgeWrapping;
    this.texture.needsUpdate = true;
  }

  /** Bilinear sample at (source angle, warp speed), full precision. */
  sample(thetaSrc: number, v: number): LutSample {
    const s = Math.max(0, Math.min(1, thetaSrc / Math.PI)) * (this.width - 1);
    const t = lutRowOfSpeed(v) * (this.height - 1);
    const s0 = Math.floor(s), t0 = Math.floor(t);
    const s1 = Math.min(this.width - 1, s0 + 1);
    const t1 = Math.min(this.height - 1, t0 + 1);
    const fs = s - s0, ft = t - t0;
    const out = [0, 0, 0, 0];
    for (let c = 0; c < 4; c++) {
      const a = this.data[(t0 * this.width + s0) * 4 + c]!;
      const b = this.data[(t0 * this.width + s1) * 4 + c]!;
      const d = this.data[(t1 * this.width + s0) * 4 + c]!;
      const e = this.data[(t1 * this.width + s1) * 4 + c]!;
      out[c] = (a * (1 - fs) + b * fs) * (1 - ft) + (d * (1 - fs) + e * fs) * ft;
    }
    return lutDecode(out[0]!, out[1]!, out[2]!, out[3]!);
  }

  dispose(): void {
    this.texture.dispose();
  }
}

/**
 * Warp one world position for a bridge observer at `obs` travelling toward +X.
 *
 * The apparent direction keeps the source azimuth (axisymmetry) and swings the
 * polar angle to the LUT's answer; distance is preserved so parallax still
 * reads. `mix` blends warped/unwarped (the hold-U comparison drives it), and
 * the far-field table is attenuated inside ~2 bubble radii of the observer,
 * where its asymptotic answer stops applying.
 */
export function warpPosition(
  lut: WarpLookup,
  px: number, py: number, pz: number,
  ox: number, oy: number, oz: number,
  v: number, mix: number, nearRadius: number,
  out: { x: number; y: number; z: number; delta: number; mag: number; vis: number },
): void {
  const dx = px - ox, dy = py - oy, dz = pz - oz;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 1e-9 || mix <= 0 || v <= 1e-6) {
    out.x = px; out.y = py; out.z = pz;
    out.delta = 1; out.mag = 1; out.vis = 1;
    return;
  }
  const thetaSrc = Math.acos(Math.max(-1, Math.min(1, dx / dist)));
  const s = lut.sample(thetaSrc, v);
  const near = Math.max(0, Math.min(1, dist / nearRadius));
  const m = mix * near * near * (3 - 2 * near); // smoothstep attenuation
  const theta = thetaSrc + (s.thetaApp - thetaSrc) * m;
  // Rotate within the plane spanned by +X and the source direction.
  const perp = Math.hypot(dy, dz);
  const ux = perp < 1e-9 ? 0 : dy / perp;
  const uz = perp < 1e-9 ? 0 : dz / perp;
  const sinT = Math.sin(theta), cosT = Math.cos(theta);
  out.x = ox + dist * cosT;
  out.y = oy + dist * sinT * ux;
  out.z = oz + dist * sinT * uz;
  out.delta = 1 + (s.delta - 1) * m;
  out.mag = 1 + (s.mag - 1) * m;
  out.vis = 1 + (s.vis - 1) * m;
}
