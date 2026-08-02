import { easeRatingMorph } from "./types";

export class RatingTransition {
  reducedMotion = false;
  private startedAt = 0;
  private durationMs = 980;
  private raw = 1;

  get progress(): number {
    return this.reducedMotion ? 1 : easeRatingMorph(this.raw);
  }

  get morphing(): boolean {
    return this.raw < 1;
  }

  retarget(now: number, durationMs = 980): void {
    this.durationMs = Math.max(1, durationMs);
    this.startedAt = now;
    this.raw = this.reducedMotion ? 1 : 0;
  }

  tick(now: number): number {
    if (this.raw >= 1) return 1;
    this.raw = Math.min(1, Math.max(0, (now - this.startedAt) / this.durationMs));
    return this.progress;
  }

  land(): void {
    this.raw = 1;
  }
}
