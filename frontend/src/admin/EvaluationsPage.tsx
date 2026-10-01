import { useQuery } from "@tanstack/react-query";
import { api, errorText } from "../api";
import { timeAgo } from "../format";
import { HBars, OTHER_COLOR, seriesColor, StackedColumns, useEvaluationTimeseries, type StackSeries } from "../charts";

export default function EvaluationsPage() {
  const feed = useQuery({
    queryKey: ["evaluations"],
    queryFn: () => api.listEvaluations(50),
    refetchInterval: 2000,
  });

  return (
    <>
      <h1>Evaluations</h1>
      <p className="muted">Every time a client system asks for a flag value, it shows up here.</p>
      <EvaluationCharts />
      {feed.isError && <p role="alert" className="error">{errorText(feed.error)}</p>}
      {feed.data?.length === 0 && (
        <p className="muted">No evaluations yet. Open the demo panel to generate some.</p>
      )}
      {feed.data && feed.data.length > 0 && (
        <table>
          <caption>Last 50 evaluations, newest first (refreshed every 2s)</caption>
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Client</th>
              <th scope="col">Flag</th>
              <th scope="col">Result</th>
            </tr>
          </thead>
          <tbody>
            {feed.data.map((e) => (
              <tr key={e.id}>
                <td>{timeAgo(e.evaluated_at)}</td>
                <td>{e.client}</td>
                <th scope="row">
                  <code>{e.flag_key}</code>{" "}
                  {!e.flag_exists && <span className="badge warn">unknown flag</span>}
                </th>
                <td><span className={`badge ${e.result ? "on" : "off"}`}>{e.result ? "ON" : "OFF"}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function EvaluationCharts() {
  const flags = useQuery({ queryKey: ["flags"], queryFn: api.listFlags, refetchInterval: 5000 });
  const timeseries = useEvaluationTimeseries(30);
  if (!timeseries.data || !flags.data) return null;

  const knownKeys = flags.data.map((f) => f.key);
  const { buckets, series, unknown_keys } = timeseries.data;
  const unknown = new Set(unknown_keys);
  const keys = Object.keys(series);
  if (keys.length === 0) {
    return <p className="muted card">No evaluations in the last 30 minutes. Open the demo panel to generate some.</p>;
  }

  // Unknown keys fold into a single gray series so they never take a flag's colour.
  const stack: StackSeries[] = keys
    .filter((k) => !unknown.has(k))
    .map((k) => ({ key: k, label: k, color: seriesColor(k, knownKeys), values: series[k] }));
  if (unknown.size > 0) {
    stack.push({
      key: "__unknown",
      label: "unknown flags",
      color: OTHER_COLOR,
      values: buckets.map((_, i) => unknown_keys.reduce((sum, k) => sum + series[k][i], 0)),
    });
  }

  const totals = keys
    .map((k) => ({ key: k, total: series[k].reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.total - a.total);

  return (
    <div className="chart-grid">
      <section className="card" aria-labelledby="per-minute-title">
        <h2 id="per-minute-title">Evaluations per minute</h2>
        <p className="muted">Last 30 minutes, stacked by flag</p>
        <StackedColumns title="Evaluations per minute" buckets={buckets} series={stack} />
      </section>
      <section className="card" aria-labelledby="by-flag-title">
        <h2 id="by-flag-title">Evaluations by flag</h2>
        <p className="muted">Last 30 minutes</p>
        <HBars
          label="Evaluations by flag in the last 30 minutes"
          rows={totals.map(({ key, total }) => ({
            key,
            label: (
              <>
                <code>{key}</code> {unknown.has(key) && <span className="badge warn">unknown</span>}
              </>
            ),
            value: total,
            valueLabel: String(total),
            color: unknown.has(key) ? OTHER_COLOR : seriesColor(key, knownKeys),
          }))}
        />
      </section>
    </div>
  );
}
