import { useApp, type ScreenId } from "./store";
import { formatUSD } from "@kayfabe/sim-core";
import { MainMenu } from "./screens/MainMenu";
import { NewUniverseWizard } from "./screens/NewUniverseWizard";
import { ControlCenter } from "./screens/ControlCenter";
import { RosterScreen } from "./screens/RosterScreen";
import { TalentMarketScreen } from "./screens/TalentMarketScreen";
import { PersonScreen } from "./screens/PersonScreen";
import { BookerScreen } from "./screens/BookerScreen";
import { LiveShowScreen } from "./screens/LiveShowScreen";
import { PostShowScreen } from "./screens/PostShowScreen";
import { CreativeScreen } from "./screens/CreativeScreen";
import { ContractsScreen } from "./screens/ContractsScreen";
import { FinanceScreen } from "./screens/FinanceScreen";
import { WireScreen } from "./screens/WireScreen";
import { CalendarScreen } from "./screens/CalendarScreen";
import { CompaniesScreen } from "./screens/CompaniesScreen";
import { TitlesScreen } from "./screens/TitlesScreen";
import { AlmanacScreen } from "./screens/AlmanacScreen";
import { SettingsScreen } from "./screens/SettingsScreen";

const SCREENS: Record<ScreenId, () => JSX.Element> = {
  control: ControlCenter,
  roster: RosterScreen,
  market: TalentMarketScreen,
  person: PersonScreen,
  booker: BookerScreen,
  live: LiveShowScreen,
  postshow: PostShowScreen,
  creative: CreativeScreen,
  contracts: ContractsScreen,
  finance: FinanceScreen,
  wire: WireScreen,
  calendar: CalendarScreen,
  companies: CompaniesScreen,
  titles: TitlesScreen,
  almanac: AlmanacScreen,
  settings: SettingsScreen,
};

const NAV: { section: string; items: { id: ScreenId; label: string }[] }[] = [
  {
    section: "Today",
    items: [
      { id: "control", label: "Control Center" },
      { id: "calendar", label: "Calendar" },
      { id: "wire", label: "Industry Wire" },
    ],
  },
  {
    section: "Creative",
    items: [
      { id: "creative", label: "Creative Room" },
      { id: "booker", label: "Show Booker" },
      { id: "live", label: "Live Show" },
      { id: "postshow", label: "Post-Show Review" },
    ],
  },
  {
    section: "Business",
    items: [
      { id: "roster", label: "Roster" },
      { id: "market", label: "Talent Market" },
      { id: "contracts", label: "Contracts" },
      { id: "finance", label: "Finance" },
      { id: "titles", label: "Championships" },
      { id: "companies", label: "World Companies" },
    ],
  },
  {
    section: "Archive",
    items: [
      { id: "almanac", label: "Historical Almanac" },
      { id: "settings", label: "Settings" },
    ],
  },
];

export function App(): JSX.Element {
  const phase = useApp((s) => s.phase);
  if (phase === "menu") return <MainMenu />;
  if (phase === "wizard") return <NewUniverseWizard />;
  return <GameShell />;
}

function GameShell(): JSX.Element {
  const screen = useApp((s) => s.screen);
  const go = useApp((s) => s.go);
  const state = useApp((s) => s.simState);
  const busy = useApp((s) => s.busy);
  const saveNotice = useApp((s) => s.saveNotice);
  const lastErrors = useApp((s) => s.lastErrors);
  const saveGame = useApp((s) => s.saveGame);
  const advanceDays = useApp((s) => s.advanceDays);

  if (!state) return <MainMenu />;
  const company = state.companies[state.meta.options.playerCompanyId]!;
  const Screen = SCREENS[screen];

  return (
    <div className="shell">
      <nav className="shell-nav" aria-label="Main navigation">
        <div className="masthead">
          THE BOOK
          <small>WRESTLING PROMOTER SIM</small>
        </div>
        {NAV.map((group) => (
          <div key={group.section}>
            <div className="nav-section">{group.section}</div>
            {group.items.map((item) => (
              <button
                key={item.id}
                className={`nav-item ${screen === item.id ? "active" : ""}`}
                onClick={() => go(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div className="shell-main">
        <header className="topbar">
          <span className="date" data-testid="game-date">
            {state.currentDate}
          </span>
          <span>{company.name}</span>
          <span className="cash" data-testid="company-cash">
            {formatUSD(company.cashCents)}
          </span>
          <span className="spacer" />
          <button onClick={() => advanceDays(1)} data-testid="advance-day" disabled={busy !== null}>
            Advance Day
          </button>
          <button onClick={() => advanceDays(7)} data-testid="advance-week" disabled={busy !== null}>
            Advance Week
          </button>
          <button className="primary" onClick={() => void saveGame()} disabled={busy !== null} data-testid="save-game">
            {busy ?? "Save"}
          </button>
        </header>
        {saveNotice && <div className="notice" data-testid="save-notice">{saveNotice}</div>}
        {lastErrors.length > 0 && (
          <div className="notice error" data-testid="engine-errors">
            {lastErrors.map((e, i) => (
              <div key={i}>{e}</div>
            ))}
          </div>
        )}
        <main>
          <Screen />
        </main>
      </div>
    </div>
  );
}
