import { useEffect, useState } from "react";
import { useApp } from "../store";
import type { SaveManifest } from "@kayfabe/sim-core";

export function MainMenu(): JSX.Element {
  const setPhase = useApp((s) => s.setPhase);
  const loadGame = useApp((s) => s.loadGame);
  const listSaveManifests = useApp((s) => s.listSaveManifests);
  const [saves, setSaves] = useState<SaveManifest[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listSaveManifests().then(setSaves, () => setSaves([]));
  }, [listSaveManifests]);

  return (
    <div style={{ display: "grid", placeItems: "center", height: "100%" }}>
      <div style={{ width: 620, maxWidth: "92vw" }}>
        <h1 className="display" style={{ fontSize: 54, letterSpacing: "0.1em", textAlign: "center" }}>
          THE BOOK
        </h1>
        <p style={{ textAlign: "center", color: "var(--ink-soft)", marginTop: 4 }}>
          Whoever holds the book runs the territory. A wrestling business simulator built on
          the Kayfabe Connectome's historical record — 365,485 documented matches, 1947–2026.
        </p>
        <div className="panel" style={{ marginTop: 28 }}>
          <div className="panel-body" style={{ display: "flex", gap: 10, justifyContent: "center" }}>
            <button className="primary" data-testid="new-universe" onClick={() => setPhase("wizard")}>
              New Universe
            </button>
          </div>
        </div>
        <div className="panel" style={{ marginTop: 14 }}>
          <div className="panel-head">Saved universes</div>
          <div className="panel-body">
            {error && <div className="notice error">{error}</div>}
            {saves.length === 0 ? (
              <div className="empty">No saved universes yet. History is waiting to be rewritten.</div>
            ) : (
              <table className="data">
                <thead>
                  <tr>
                    <th>Save</th>
                    <th>Game date</th>
                    <th>Started</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {saves.map((m) => (
                    <tr key={m.save_id}>
                      <td>{m.save_id}</td>
                      <td>{m.current_game_date}</td>
                      <td>{m.original_start_date}</td>
                      <td>
                        <button
                          data-testid={`load-${m.save_id}`}
                          onClick={() => void loadGame(m.save_id).catch((e) => setError(String(e)))}
                        >
                          Continue
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
        <p style={{ textAlign: "center", color: "var(--ink-faint)", fontSize: 12, marginTop: 18 }}>
          Alternate history begins where the record ends. The record itself is never rewritten.
        </p>
      </div>
    </div>
  );
}
