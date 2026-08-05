/**
 * The key to the crowd.
 *
 * The seats are people, and four poses with no legend is a private code — so
 * the figures are redrawn here as SVG from the SAME numbers the shader uses
 * (`ArenaCards.ts` FIGURE_GLSL, scaled by 100 into a 0-at-the-feet frame that
 * SVG then flips). A key that described the poses in words instead would drift
 * away from them the first time either side was tuned.
 *
 * Opponent versus tag partner is stated even though colour already carries it:
 * colour separates a populated arena at a glance, but one figure on its own has
 * nothing to compare itself against.
 */
import type { JSX } from "react";
import { PAIR_DX, PAIR_SCALE } from "@kayfabe/arena-renderer";

const INK = "#c7d1e6";
const GOLD = "#ffcc61";

/** Figure-frame (y up from the feet) into the SVG viewBox (y down). */
const P = (x: number, y: number): string => `${x * 100} ${(1 - y) * 100}`;

function Body({ champ, x, s }: { champ: boolean; x: number; s: number }): JSX.Element {
  const armY = champ ? 0.905 : 0.425;
  const armX = champ ? 0.15 : 0.165;
  return (
    <g transform={`translate(${x * 100} ${100 - s * 100}) scale(${s})`}>
      <circle cx={0} cy={(1 - 0.795) * 100} r={7.6} />
      <path
        d={`M ${P(0, 0.66)} L ${P(0, 0.745)}`}
        stroke={INK} strokeWidth={5.2} strokeLinecap="round" fill="none"
      />
      <rect x={-8.8} y={(1 - 0.675) * 100} width={17.6} height={26} rx={3} />
      <path
        d={`M ${P(-0.036, 0.41)} L ${P(-0.062, 0.036)} M ${P(0.036, 0.41)} L ${P(0.062, 0.036)}
            M ${P(-0.094, 0.665)} L ${P(-armX, armY)} M ${P(0.094, 0.665)} L ${P(armX, armY)}`}
        stroke={INK} strokeWidth={5.6} strokeLinecap="round" fill="none"
      />
    </g>
  );
}

function Belt({ tag, x, y, k }: { tag: boolean; x: number; y: number; k: number }): JSX.Element {
  return (
    <g transform={`translate(${x * 100} ${(1 - y) * 100}) scale(${k})`} fill={GOLD}>
      <rect x={-12.5} y={-3} width={25} height={6} rx={3} />
      {tag ? (
        <>
          <circle cx={-5.2} cy={0} r={4.2} />
          <circle cx={5.2} cy={0} r={4.2} />
        </>
      ) : (
        <circle cx={0} cy={0} r={5.6} />
      )}
    </g>
  );
}

type Pose = "solo" | "pair" | "belt" | "tagBelt";

function Seat({ pose }: { pose: Pose }): JSX.Element {
  const pair = pose === "pair";
  const champ = pose === "belt" || pose === "tagBelt";
  const s = pair ? PAIR_SCALE : 1;
  const dx = pair ? PAIR_DX : 0;
  return (
    <svg className="arena-key-glyph" viewBox="-30 -4 60 108" aria-hidden="true">
      <g fill={INK} stroke="none">
        <Body champ={champ} x={-dx} s={s} />
        {pair && <Body champ={champ} x={dx} s={s} />}
      </g>
      {pose === "belt" && <Belt tag={false} x={0} y={0.945} k={1.15} />}
      {pose === "tagBelt" && <Belt tag x={0} y={0.445} k={0.8} />}
    </svg>
  );
}

export function ArenaGlyphKey({ person }: { person: boolean }): JSX.Element {
  return (
    <div className="arena-key" aria-label="What a figure in the crowd means">
      {person ? (
        <>
          <span className="arena-key-item"><Seat pose="solo" />documented opponent</span>
          <span className="arena-key-item"><Seat pose="pair" />documented tag partner</span>
        </>
      ) : (
        <span className="arena-key-item"><Seat pose="solo" />documented worker</span>
      )}
      <span className="arena-key-item"><Seat pose="belt" />held a title alone</span>
      <span className="arena-key-item"><Seat pose="tagBelt" />held a title with a partner</span>
    </div>
  );
}
