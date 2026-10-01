import { useFlags } from "../useFlags";

const FLAG_KEYS = ["announcement-banner", "new-reports", "beta-search", "maintenance-mode"] as const;

export default function DemoPage() {
  const { flags, ready, stale, lastUpdated } = useFlags(FLAG_KEYS, { client: "demo-panel" });

  return (
    <div className="demo">
      <header className="demo-header">
        <div>
          <h1>Ops Panel</h1>
          <p className="muted">
            Demo consumer — every widget is gated by a feature flag evaluated by <code>client=demo-panel</code>.
          </p>
        </div>
        <p className="muted">{ready ? `Flags synced at ${new Date(lastUpdated).toLocaleTimeString()}` : "Loading flags…"}</p>
      </header>

      {stale && (
        <p role="alert" className="stale">
          ⚠ Flag service unreachable — using last known values{ready ? "" : " (defaults: all off)"}.
        </p>
      )}

      {!ready && !stale ? null : flags["maintenance-mode"] ? (
        <section className="maintenance" aria-labelledby="maintenance-title">
          <h2 id="maintenance-title">Down for maintenance</h2>
          <p>This panel is disabled by the <code>maintenance-mode</code> kill switch.</p>
        </section>
      ) : (
        <>
          {flags["announcement-banner"] && (
            <div className="banner" role="note">
              📣 Quarterly planning starts Monday — check the new roadmap.
              <FlagTag flagKey="announcement-banner" />
            </div>
          )}
          {flags["beta-search"] && (
            <div className="card search">
              <label htmlFor="demo-search">Search (beta)</label>
              <input id="demo-search" type="search" placeholder="Search incidents, services, people…" />
              <FlagTag flagKey="beta-search" />
            </div>
          )}
          <div className="widgets">
            <section className="card" aria-labelledby="incidents-title">
              <h2 id="incidents-title">Open incidents</h2>
              <p className="big">3</p>
            </section>
            {flags["new-reports"] ? <NewReports /> : <LegacyReports />}
            <section className="card" aria-labelledby="deploys-title">
              <h2 id="deploys-title">Deploys today</h2>
              <p className="big">12</p>
            </section>
          </div>
        </>
      )}

      <footer className="card">
        <h2>Flag values seen by this client</h2>
        <ul className="flag-values">
          {FLAG_KEYS.map((key) => (
            <li key={key}>
              <code>{key}</code>{" "}
              <span className={`badge ${flags[key] ? "on" : "off"}`}>{flags[key] ? "ON" : "OFF"}</span>
            </li>
          ))}
        </ul>
      </footer>
    </div>
  );
}

function FlagTag({ flagKey }: { flagKey: string }) {
  return <span className="flag-tag">flag: {flagKey}</span>;
}

const REPORT_DATA = [
  { team: "Payments", tickets: 42 },
  { team: "Search", tickets: 27 },
  { team: "Auth", tickets: 18 },
];

function NewReports() {
  const max = Math.max(...REPORT_DATA.map((r) => r.tickets));
  return (
    <section className="card" aria-labelledby="reports-title">
      <h2 id="reports-title">Reports v2 <FlagTag flagKey="new-reports" /></h2>
      <ul className="bars">
        {REPORT_DATA.map((r) => (
          <li key={r.team}>
            <span>{r.team}</span>
            <span className="bar" style={{ width: `${(r.tickets / max) * 100}%` }} aria-hidden="true" />
            <span>{r.tickets}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function LegacyReports() {
  return (
    <section className="card" aria-labelledby="reports-title">
      <h2 id="reports-title">Reports (legacy)</h2>
      <table>
        <tbody>
          {REPORT_DATA.map((r) => (
            <tr key={r.team}>
              <th scope="row">{r.team}</th>
              <td>{r.tickets}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
