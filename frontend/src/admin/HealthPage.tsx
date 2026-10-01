import { useQuery } from "@tanstack/react-query";
import { api, errorText } from "../api";
import { formatUptime } from "../format";

export default function HealthPage() {
  const health = useQuery({ queryKey: ["healthz"], queryFn: api.health, refetchInterval: 5000, retry: false });
  const metrics = useQuery({ queryKey: ["metrics"], queryFn: api.getMetrics, refetchInterval: 5000 });

  const routes = Object.entries(metrics.data?.routes ?? {}).sort(([, a], [, b]) => b.count - a.count);
  const total = routes.reduce((sum, [, m]) => sum + m.count, 0);
  const errors5xx = routes.reduce((sum, [, m]) => sum + m.errors_5xx, 0);
  const status = health.isSuccess ? "Healthy" : health.isError ? "Unavailable" : "Checking…";

  return (
    <>
      <h1>System health</h1>
      <div className="tiles">
        <div className="tile">
          <p>Status</p>
          <strong className={health.isError ? "error" : undefined}>{status}</strong>
        </div>
        <div className="tile">
          <p>Uptime</p>
          <strong>{metrics.data ? formatUptime(metrics.data.uptime_seconds) : "—"}</strong>
        </div>
        <div className="tile">
          <p>Requests</p>
          <strong>{total}</strong>
        </div>
        <div className="tile">
          <p>5xx error rate</p>
          <strong>{total ? `${((errors5xx / total) * 100).toFixed(1)}%` : "—"}</strong>
        </div>
      </div>
      {metrics.isError && <p role="alert" className="error">{errorText(metrics.error)}</p>}
      <table>
        <caption>HTTP metrics per endpoint since the last restart (in-memory, refreshed every 5s)</caption>
        <thead>
          <tr>
            <th scope="col">Endpoint</th>
            <th scope="col">Requests</th>
            <th scope="col">4xx</th>
            <th scope="col">5xx</th>
            <th scope="col">Avg ms</th>
            <th scope="col">Max ms</th>
          </tr>
        </thead>
        <tbody>
          {routes.map(([route, m]) => (
            <tr key={route}>
              <th scope="row"><code>{route}</code></th>
              <td>{m.count}</td>
              <td>{m.errors_4xx}</td>
              <td className={m.errors_5xx ? "error" : undefined}>{m.errors_5xx}</td>
              <td>{m.avg_ms}</td>
              <td>{m.max_ms}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
