import { useStore } from "../state/store";
import { useAtlas } from "./atlasStore";

/**
 * Where you are in the hierarchy, and the way back up.
 *
 * Deliberately NOT a second navigation history. Each crumb is a selection, and
 * selecting is what the shared store already records — so Back, Escape, the
 * dossier trail and these crumbs all move through one model instead of three
 * that can disagree.
 */
export function AtlasBreadcrumbs() {
  const scene = useAtlas((s) => s.scene);
  const building = useAtlas((s) => s.building);
  const select = useStore((s) => s.select);
  if (!scene) return null;

  return (
    <nav className="atlas-crumbs" aria-label="Atlas hierarchy">
      {scene.breadcrumbs.map((c, i) => (
        <span key={c.id ?? "root"}>
          {i > 0 && <span className="sep" aria-hidden="true">›</span>}
          <button
            className={i === scene.breadcrumbs.length - 1 ? "crumb here" : "crumb"}
            aria-current={i === scene.breadcrumbs.length - 1 ? "page" : undefined}
            onClick={() => select(c.id ? { kind: "node", id: c.id } : null)}
          >
            {c.label}
          </button>
        </span>
      ))}
      {building && <span className="micro loading-dot">loading detail…</span>}
    </nav>
  );
}
