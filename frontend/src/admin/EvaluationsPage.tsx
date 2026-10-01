import { useQuery } from "@tanstack/react-query";
import { api, errorText } from "../api";
import { timeAgo } from "../format";

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
