export type QualityTier = "high" | "medium" | "low";

export interface QualitySettings {
  pixelRatioCap: number;
  bloom: boolean;
  edgeCap: number;
  labelCap: number;
}

export const TIERS: Record<QualityTier, QualitySettings> = {
  high: { pixelRatioCap: 2, bloom: true, edgeCap: 24000, labelCap: 26 },
  medium: { pixelRatioCap: 1.5, bloom: true, edgeCap: 14000, labelCap: 18 },
  low: { pixelRatioCap: 1, bloom: false, edgeCap: 8000, labelCap: 10 },
};

/**
 * Watches the frame-time EMA and steps the tier down (fast) or up (slow, and
 * only after sustained headroom). Never touches selection/path visibility —
 * those cuts are structurally impossible here because it only exposes caps.
 */
export class QualityGovernor {
  tier: QualityTier;
  private ema = 16;
  private below = 0;
  private above = 0;
  onChange: ((tier: QualityTier, s: QualitySettings) => void) | null = null;

  constructor(initial: QualityTier = "high") {
    this.tier = initial;
  }

  get settings(): QualitySettings {
    return TIERS[this.tier];
  }

  frame(dtMs: number): void {
    this.ema = this.ema * 0.95 + dtMs * 0.05;
    if (this.ema > 30) {
      this.above++;
      this.below = 0;
    } else if (this.ema < 15) {
      this.below++;
      this.above = 0;
    } else {
      this.above = 0;
      this.below = 0;
    }
    if (this.above > 90 && this.tier !== "low") {
      this.set(this.tier === "high" ? "medium" : "low");
      this.above = 0;
    } else if (this.below > 600 && this.tier !== "high") {
      this.set(this.tier === "low" ? "medium" : "high");
      this.below = 0;
    }
  }

  set(tier: QualityTier): void {
    if (tier === this.tier) return;
    this.tier = tier;
    this.onChange?.(tier, TIERS[tier]);
  }

  frameTimeMs(): number {
    return this.ema;
  }
}
