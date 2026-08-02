export type RatingRgb = readonly [number, number, number];

/** MELTZER RIDGE — archival calibration palette, linear RGB inputs. */
export const RATING_PALETTE = {
  ink: 0x03070b,
  inkLift: 0x081016,
  graphite: 0x182127,
  rail: 0x52626c,
  railDark: 0x202b32,
  ratedWarm: 0xb8753e,
  ratedHot: 0xe0a864,
  datum: 0xf1d6a2,
  paper: 0xe6e1d5,
  negative: 0x8a91b8,
  current: 0xf7eee0,
} as const;

export function hexRgb(hex: number): RatingRgb {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}
