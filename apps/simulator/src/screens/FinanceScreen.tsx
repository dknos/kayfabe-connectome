import { useMemo, useState } from "react";
import { useApp } from "../store";
import { addDays, formatUSD } from "@kayfabe/sim-core";

export function FinanceScreen(): JSX.Element {
  const state = useApp((s) => s.simState)!;
  const [filter, setFilter] = useState("all");

  const playerId = state.meta.options.playerCompanyId;
  const company = state.companies[playerId]!;
  const txs = useMemo(() => state.ledger.filter((t) => t.companyId === playerId), [state, playerId]);

  const since7 = addDays(state.currentDate, -7);
  const since30 = addDays(state.currentDate, -30);
  const net = (from: string): number =>
    txs.filter((t) => t.date >= from).reduce((s, t) => s + (t.direction === "in" ? t.amountCents : -t.amountCents), 0);

  const weeklyDownside = Object.keys(state.contracts)
    .sort()
    .map((id) => state.contracts[id]!)
    .filter((c) => c.companyId === playerId && c.status === "active")
    .reduce((s, c) => s + c.weeklyDownsideCents, 0);

  const categories = [...new Set(txs.map((t) => t.category))].sort();
  const byCat = new Map<string, { inC: number; outC: number }>();
  for (const t of txs.filter((t) => t.date >= since30)) {
    const e = byCat.get(t.category) ?? { inC: 0, outC: 0 };
    if (t.direction === "in") e.inC += t.amountCents;
    else e.outC += t.amountCents;
    byCat.set(t.category, e);
  }

  const shown = txs.filter((t) => filter === "all" || t.category === filter).slice(-200).reverse();
  // Running balance: replay from initial cash forward, then map to the shown window.
  const balances = new Map<string, number>();
  {
    const initial = company.cashCents - txs.reduce((s, t) => s + (t.direction === "in" ? t.amountCents : -t.amountCents), 0);
    let bal = initial;
    for (const t of txs) {
      bal += t.direction === "in" ? t.amountCents : -t.amountCents;
      balances.set(t.id, bal);
    }
  }

  return (
    <div className="page">
      <div className="page-title">
        <h1>Finance</h1>
        <span className="sub">every dollar accounted for</span>
      </div>
      <div className="cols cols-3">
        <div className="panel"><div className="panel-body" style={{ textAlign: "center" }}>
          <div className="grade">{formatUSD(company.cashCents, { compact: true })}</div><div>cash on hand</div>
        </div></div>
        <div className="panel"><div className="panel-body" style={{ textAlign: "center" }}>
          <div className={`grade ${net(since7) >= 0 ? "good" : "bad"}`}>{formatUSD(net(since7), { compact: true })}</div><div>last 7 days</div>
        </div></div>
        <div className="panel"><div className="panel-body" style={{ textAlign: "center" }}>
          <div className={`grade ${net(since30) >= 0 ? "good" : "bad"}`}>{formatUSD(net(since30), { compact: true })}</div>
          <div>last 30 days · {formatUSD(weeklyDownside, { compact: true })}/wk guaranteed out</div>
        </div></div>
      </div>

      <div className="cols cols-sidebar" style={{ marginTop: 14 }}>
        <div className="panel">
          <div className="panel-head">
            Ledger
            <span style={{ marginLeft: "auto" }}>
              <select value={filter} onChange={(e) => setFilter(e.target.value)}>
                <option value="all">all categories</option>
                {categories.map((c) => (
                  <option key={c} value={c}>{c.replace("_", " ")}</option>
                ))}
              </select>
            </span>
          </div>
          <div className="panel-body" style={{ padding: 0, maxHeight: "58vh", overflowY: "auto" }}>
            {shown.length === 0 ? (
              <div className="empty">No transactions yet. That changes on show night.</div>
            ) : (
              <table className="data" data-testid="finance-ledger">
                <thead>
                  <tr>
                    <th>Date</th><th /><th>Category</th><th>Memo</th><th className="num">Amount</th><th className="num">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((t) => (
                    <tr key={t.id}>
                      <td>{t.date}</td>
                      <td style={{ color: t.direction === "in" ? "var(--green)" : "var(--alert)" }}>{t.direction === "in" ? "▲" : "▼"}</td>
                      <td>{t.category.replace("_", " ")}</td>
                      <td>{t.memo}</td>
                      <td className="num" style={{ color: t.direction === "in" ? "var(--green)" : "var(--alert)" }}>
                        {t.direction === "in" ? "" : "−"}{formatUSD(t.amountCents)}
                      </td>
                      <td className="num">{formatUSD(balances.get(t.id) ?? 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {txs.length > 200 && <div className="panel-body confidence">showing the most recent 200 of {txs.length} transactions</div>}
          </div>
        </div>
        <div className="panel">
          <div className="panel-head">Last 30 days by category</div>
          <div className="panel-body" style={{ padding: 0 }}>
            <table className="data">
              <thead><tr><th>Category</th><th className="num">In</th><th className="num">Out</th></tr></thead>
              <tbody>
                {[...byCat.keys()].sort().map((c) => (
                  <tr key={c}>
                    <td>{c.replace("_", " ")}</td>
                    <td className="num" style={{ color: "var(--green)" }}>{formatUSD(byCat.get(c)!.inC, { compact: true })}</td>
                    <td className="num" style={{ color: "var(--alert)" }}>{formatUSD(byCat.get(c)!.outC, { compact: true })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
