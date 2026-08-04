import { useStore } from "../state/store";
import { SearchBox } from "./SearchBox";

export function TopBar({ onScreenshot }: { onScreenshot: () => void }) {
  const core = useStore((s) => s.core);
  const lens = useStore((s) => s.lens);
  const setLens = useStore((s) => s.setLens);
  const announce = useStore((s) => s.announce);

  const share = async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      announce("View link copied to clipboard.");
    } catch {
      announce(`Copy failed — the link is ${location.href}`);
    }
  };

  return (
    <header className="topbar">
      <div className="brand">
        <b>KAYFABE CONNECTOME</b>
        <span className="micro">documented wrestling network</span>
      </div>
      <SearchBox />
      <div role="group" aria-label="Lens">
        <button className={lens === "connectome" ? "active" : ""} onClick={() => setLens("connectome")}>
          Connectome
        </button>{" "}
        <button className={lens === "morph" ? "active" : ""} onClick={() => setLens("morph")}>
          Morph Lab
        </button>{" "}
        <button className={lens === "arena" ? "active" : ""} onClick={() => setLens("arena")}>
          Arena Array
        </button>{" "}
        <button className={lens === "spacetime" ? "active" : ""} onClick={() => setLens("spacetime")}>
          Spacetime
        </button>
        <button className={lens === "ratings" ? "active" : ""} onClick={() => setLens("ratings")}>
          Meltzer Ratings
        </button>{" "}
        <button className={lens === "geo" ? "active" : ""} onClick={() => setLens("geo")}>
          Geo Replay β
        </button>
      </div>
      <div className="spacer" />
      {core && (
        <div className="coverage micro" title="Corpus coverage — local SQL + csv sources">
          <b className="num">
            {(
              (core.manifest.counts.people ?? 0) +
              (core.manifest.counts.derived_people ?? 0) +
              (core.manifest.counts.csv_people ?? 0)
            ).toLocaleString()}
          </b>{" "}
          people ·{" "}
          <b className="num">{core.manifest.counts.matches?.toLocaleString()}</b> matches ·{" "}
          <b className="num">{core.manifest.counts.promotions?.toLocaleString()}</b> promotions ·{" "}
          <b className="num">{core.manifest.date_range[0].slice(0, 4)}–{core.manifest.date_range[1].slice(0, 4)}</b>
        </div>
      )}
      <button className="desktop-only" onClick={share}>Share view</button>
      <button className="desktop-only" onClick={onScreenshot}>Screenshot</button>
    </header>
  );
}
