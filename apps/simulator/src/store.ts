import { create } from "zustand";
import type {
  Command,
  EngineResult,
  OfferOutcome,
  ShowReport,
  SimState,
  UniverseSnapshot,
} from "@kayfabe/sim-contract";
import { applyCommand, buildSaveEnvelope, openSaveEnvelope } from "@kayfabe/sim-core";
import { getSave, listSaves, putSave } from "./saves";

export type ScreenId =
  | "control"
  | "roster"
  | "market"
  | "person"
  | "booker"
  | "live"
  | "postshow"
  | "creative"
  | "contracts"
  | "finance"
  | "wire"
  | "calendar"
  | "companies"
  | "titles"
  | "almanac"
  | "settings";

export interface AppStore {
  phase: "menu" | "wizard" | "game";
  screen: ScreenId;
  simState: SimState | null;
  /** Snapshot kept for provenance displays (data health, seeding methods). */
  snapshot: UniverseSnapshot | null;
  lastReport: ShowReport | null;
  lastOffer: OfferOutcome | null;
  lastErrors: string[];
  /** Navigation context. */
  selectedPersonId: string | null;
  selectedShowId: string | null;
  busy: string | null;
  saveNotice: string | null;

  setPhase(phase: AppStore["phase"]): void;
  go(screen: ScreenId): void;
  openPerson(personId: string): void;
  openShow(showId: string, screen?: ScreenId): void;
  startUniverse(state: SimState, snapshot: UniverseSnapshot): void;
  dispatch(cmd: Command): EngineResult;
  advanceDays(days: number): void;
  saveGame(): Promise<void>;
  loadGame(saveId: string): Promise<void>;
  listSaveManifests(): ReturnType<typeof listSaves>;
}

export const useApp = create<AppStore>((set, get) => ({
  phase: "menu",
  screen: "control",
  simState: null,
  snapshot: null,
  lastReport: null,
  lastOffer: null,
  lastErrors: [],
  selectedPersonId: null,
  selectedShowId: null,
  busy: null,
  saveNotice: null,

  setPhase: (phase) => set({ phase }),
  go: (screen) => set({ screen, lastErrors: [] }),
  openPerson: (personId) => set({ selectedPersonId: personId, screen: "person" }),
  openShow: (showId, screen = "booker") => set({ selectedShowId: showId, screen }),

  startUniverse: (state, snapshot) =>
    set({
      simState: state,
      snapshot,
      phase: "game",
      screen: "control",
      lastReport: null,
      lastErrors: [],
    }),

  dispatch: (cmd) => {
    const prev = get().simState;
    if (!prev) throw new Error("no universe loaded");
    const result = applyCommand(prev, cmd);
    set({
      simState: result.state,
      lastErrors: result.errors,
      lastReport: result.report ?? get().lastReport,
      lastOffer: cmd.type === "OFFER_CONTRACT" ? result.offerOutcome : get().lastOffer,
    });
    return result;
  },

  advanceDays: (days) => {
    const { dispatch } = get();
    for (let i = 0; i < days; i++) {
      const res = dispatch({ type: "ADVANCE_DAY" });
      if (res.errors.length > 0) break;
    }
  },

  saveGame: async () => {
    const state = get().simState;
    if (!state) return;
    set({ busy: "Saving…" });
    try {
      const envelope = buildSaveEnvelope(state, new Date().toISOString());
      await putSave(envelope);
      set({ saveNotice: `Saved ${envelope.manifest.save_id} @ ${envelope.manifest.current_game_date}` });
    } finally {
      set({ busy: null });
    }
  },

  loadGame: async (saveId) => {
    set({ busy: "Loading…" });
    try {
      const envelope = await getSave(saveId);
      if (!envelope) throw new Error(`save ${saveId} not found`);
      const { state, warnings } = openSaveEnvelope(envelope, null);
      set({
        simState: state,
        phase: "game",
        screen: "control",
        lastErrors: warnings,
        lastReport: null,
      });
    } finally {
      set({ busy: null });
    }
  },

  listSaveManifests: () => listSaves(),
}));

/** The player's company, or throw — game screens may assume a loaded universe. */
export function usePlayerCompany() {
  const state = useApp((s) => s.simState);
  if (!state) throw new Error("no universe");
  return state.companies[state.meta.options.playerCompanyId]!;
}
