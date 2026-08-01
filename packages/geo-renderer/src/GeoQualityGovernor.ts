import type { QualityTier } from "./types";

export interface GeoQualitySettings {
  /** Simultaneously animating beacon cores. */
  beaconCap: number;
  /** Expanding rings — the most expensive per-item effect. */
  ringCap: number;
  /** Vertical light columns. */
  columnCap: number;
  arcCap: number;
  labelCap: number;
  /** Persistent accumulated-heat points drawn at once. */
  heatCap: number;
  /** Beacon animation length, ms. */
  beaconMs: number;
  ringMs: number;
  atmosphere: boolean;
  resolutionScale: number;
}

/**
 * Caps only VISUAL budgets. Analytical counts — cards processed, matches
 * represented, unique places, title changes — are computed by the scheduler
 * and never consult this, so lowering the tier can change how the globe looks
 * but can never change a number the inspector reports.
 */
export const GEO_TIERS: Record<QualityTier, GeoQualitySettings> = {
  high: {
    beaconCap: 220, ringCap: 120, columnCap: 90, arcCap: 260, labelCap: 22,
    heatCap: 2600, beaconMs: 1500, ringMs: 1300, atmosphere: true, resolutionScale: 1,
  },
  medium: {
    beaconCap: 130, ringCap: 60, columnCap: 48, arcCap: 150, labelCap: 14,
    heatCap: 1600, beaconMs: 1200, ringMs: 1000, atmosphere: true, resolutionScale: 1,
  },
  low: {
    beaconCap: 70, ringCap: 0, columnCap: 0, arcCap: 70, labelCap: 8,
    heatCap: 900, beaconMs: 900, ringMs: 0, atmosphere: false, resolutionScale: 0.85,
  },
};

/**
 * Steps down fast on sustained slow frames, up slowly and only after real
 * headroom, so the tier does not oscillate while the camera is moving.
 */
export class GeoQualityGovernor {
  tier: QualityTier;
  private ema = 16;
  private slow = 0;
  private fast = 0;
  onChange: ((tier: QualityTier, s: GeoQualitySettings) => void) | null = null;

  constructor(initial: QualityTier = "high") {
    this.tier = initial;
  }

  get settings(): GeoQualitySettings {
    return GEO_TIERS[this.tier];
  }

  get frameMs(): number {
    return this.ema;
  }

  /** Force a tier and stop adapting away from it for a while. */
  set(tier: QualityTier): void {
    if (tier === this.tier) return;
    this.tier = tier;
    this.slow = 0;
    this.fast = 0;
    this.onChange?.(tier, this.settings);
  }

  frame(dtMs: number): void {
    this.ema = this.ema * 0.9 + dtMs * 0.1;
    if (this.ema > 34) {
      this.slow++;
      this.fast = 0;
    } else if (this.ema < 19) {
      this.fast++;
      this.slow = 0;
    } else {
      this.slow = 0;
      this.fast = 0;
    }
    if (this.slow > 24 && this.tier !== "low") {
      this.set(this.tier === "high" ? "medium" : "low");
    } else if (this.fast > 260 && this.tier !== "high") {
      this.set(this.tier === "low" ? "medium" : "high");
    }
  }
}
