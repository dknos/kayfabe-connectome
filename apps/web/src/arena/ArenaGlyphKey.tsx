/**
 * The key to the marks printed on the cards.
 *
 * Four glyphs with no legend is a private code, so the shapes are redrawn here
 * as SVG at the same proportions the shader uses — the numbers below are the
 * ones in `ArenaCards.ts` GLYPH_GLSL, scaled by 100 with y flipped for SVG's
 * downward axis. A key that merely described the marks in words would drift
 * away from them the first time either side was tuned.
 *
 * The partner/opponent pair is stated here too even though the card's accent
 * colour already carries it: colour separates a populated arena at a glance,
 * but a single inspected card has nothing to compare itself against.
 */
import type { JSX } from "react";

const INK = "#c7d1e6";
const GOLD = "#ffcc61";

function Figure({ pair }: { pair: boolean }): JSX.Element {
  const dx = pair ? 6.2 : 0;
  const s = pair ? 0.8 : 1;
  const one = (cx: number, i: number): JSX.Element => (
    <g key={i} transform={`translate(${cx} 0) scale(${s})`}>
      <circle cx={0} cy={-5.2} r={3.8} />
      <rect x={-6.8} y={-2.1} width={13.6} height={13.2} rx={1.6} />
    </g>
  );
  return (
    <svg className="arena-key-glyph" viewBox="-14 -12 28 26" aria-hidden="true">
      <g fill={INK}>{pair ? [one(-dx, 0), one(dx, 1)] : [one(0, 0)]}</g>
    </svg>
  );
}

function Belt({ tag }: { tag: boolean }): JSX.Element {
  return (
    <svg className="arena-key-glyph" viewBox="-14 -12 28 26" aria-hidden="true">
      <g fill={GOLD}>
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
    </svg>
  );
}

export function ArenaGlyphKey({ person }: { person: boolean }): JSX.Element {
  return (
    <div className="arena-key" aria-label="What the marks on a card mean">
      {person && (
        <>
          <span className="arena-key-item"><Figure pair={false} />documented opponent</span>
          <span className="arena-key-item"><Figure pair />documented tag partner</span>
        </>
      )}
      {!person && (
        <span className="arena-key-item"><Figure pair={false} />documented worker</span>
      )}
      <span className="arena-key-item"><Belt tag={false} />held a title alone</span>
      <span className="arena-key-item"><Belt tag />held a title with a partner</span>
    </div>
  );
}
