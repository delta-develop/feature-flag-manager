import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

// Reference categorical palette, validated for colour-vision deficiency on the white card surface.
// Fixed order, never cycled: a 9th flag folds into OTHER_COLOR.
const SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];
export const PRIMARY_COLOR = SERIES[0];
export const OTHER_COLOR = "#898781";

/** Colour follows the flag (its position among all flag keys), never its rank in a chart. */
export function seriesColor(key: string, knownKeys: string[]): string {
  const index = [...knownKeys].sort().indexOf(key);
  return index >= 0 && index < SERIES.length ? SERIES[index] : OTHER_COLOR;
}

export function useEvaluationTimeseries(minutes = 30) {
  return useQuery({
    queryKey: ["timeseries", minutes],
    queryFn: () => api.getTimeseries(minutes),
    refetchInterval: 5000,
  });
}

const hhmm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function niceMax(value: number): number {
  const pow = 10 ** Math.floor(Math.log10(value));
  return [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((m) => m * pow).find((n) => n >= value)!;
}

/** Column path with a rounded data-end (top) and a square baseline. */
function columnPath(x: number, y: number, w: number, h: number, r: number): string {
  r = Math.min(r, h, w / 2);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

export function Legend({ items }: { items: { key: string; label: string; color: string }[] }) {
  return (
    <ul className="legend">
      {items.map((item) => (
        <li key={item.key}>
          <span className="swatch" style={{ background: item.color }} aria-hidden="true" />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

export type StackSeries = { key: string; label: string; color: string; values: number[] };

export function StackedColumns({ title, buckets, series }: { title: string; buckets: string[]; series: StackSeries[] }) {
  const [active, setActive] = useState<number | null>(null);
  const W = 640, H = 200, padL = 36, padR = 8, padT = 8, padB = 24;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const baseline = padT + plotH;
  const totals = buckets.map((_, i) => series.reduce((sum, s) => sum + s.values[i], 0));
  const max = niceMax(Math.max(1, ...totals));
  const slot = plotW / buckets.length;
  const barW = Math.min(24, slot - 2);
  const scale = (v: number) => (v / max) * plotH;
  const ticks = [0, max / 2, max].filter(Number.isInteger);

  return (
    <figure className="chart">
      <div className="chart-plot" onPointerLeave={() => setActive(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}: ${totals.reduce((a, b) => a + b, 0)} in total`}>
          {ticks.map((t) => (
            <g key={t}>
              <line className="grid" x1={padL} x2={W - padR} y1={baseline - scale(t)} y2={baseline - scale(t)} />
              <text className="tick" x={padL - 6} y={baseline - scale(t) + 4} textAnchor="end">{t}</text>
            </g>
          ))}
          {buckets.map((bucket, i) => {
            const x = padL + i * slot + (slot - barW) / 2;
            const segments = series.filter((s) => s.values[i] > 0);
            let base = baseline;
            return (
              <g key={bucket}>
                {segments.map((s, j) => {
                  const h = scale(s.values[i]);
                  const top = base - h;
                  const gap = j > 0 ? 2 : 0; // surface gap between stacked segments
                  base = top;
                  return (
                    <path
                      key={s.key}
                      d={columnPath(x, top, barW, Math.max(h - gap, 1), j === segments.length - 1 ? 4 : 0)}
                      fill={s.color}
                      opacity={active === null || active === i ? 1 : 0.5}
                    />
                  );
                })}
                {(buckets.length - 1 - i) % 5 === 0 && (
                  <text className="tick" x={i === buckets.length - 1 ? x + barW : x + barW / 2} y={H - 6} textAnchor={i === buckets.length - 1 ? "end" : "middle"}>
                    {hhmm(bucket)}
                  </text>
                )}
                <rect
                  x={padL + i * slot}
                  y={padT}
                  width={slot}
                  height={plotH}
                  fill="transparent"
                  onPointerEnter={() => setActive(i)}
                />
              </g>
            );
          })}
          <line className="baseline" x1={padL} x2={W - padR} y1={baseline} y2={baseline} />
        </svg>
        {active !== null && (
          <div
            className="chart-tooltip"
            style={{ left: `${((padL + (active + 0.5) * slot) / W) * 100}%` }}
            role="status"
          >
            <p className="muted">{hhmm(buckets[active])} · {totals[active]} total</p>
            <ul>
              {series.map((s) => (
                <li key={s.key}>
                  <span className="line-key" style={{ background: s.color }} aria-hidden="true" />
                  <strong>{s.values[active]}</strong> <span className="muted">{s.label}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <Legend items={series} />
      <details className="data-table">
        <summary>Show data table</summary>
        <table>
          <thead>
            <tr>
              <th scope="col">Minute</th>
              {series.map((s) => <th scope="col" key={s.key}>{s.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {buckets.map((bucket, i) => (
              <tr key={bucket}>
                <th scope="row">{hhmm(bucket)}</th>
                {series.map((s) => <td key={s.key}>{s.values[i]}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

export type BarRow = { key: string; label: ReactNode; value: number; valueLabel: string; color: string; marker?: number };

/** Horizontal bars with the value at the tip; optional thin marker (e.g. max latency). */
export function HBars({ rows, label }: { rows: BarRow[]; label: string }) {
  // Headroom so a max marker never sits on the track's edge.
  const top = Math.max(1, ...rows.map((r) => Math.max(r.value, r.marker ?? 0))) * 1.05;
  return (
    <ul className="hbars" aria-label={label}>
      {rows.map((r) => (
        <li key={r.key}>
          <span className="hbar-label">{r.label}</span>
          <span className="hbar-track">
            <span className="hbar" style={{ width: `${(r.value / top) * 100}%`, background: r.color }} />
            {r.marker !== undefined && (
              <span className="hbar-marker" style={{ left: `${(r.marker / top) * 100}%` }} aria-hidden="true" />
            )}
          </span>
          <span className="hbar-value">{r.valueLabel}</span>
        </li>
      ))}
    </ul>
  );
}

export function Sparkline({ values, color, label }: { values: number[]; color: string; label: string }) {
  const W = 120, H = 28, pad = 4;
  const max = Math.max(1, ...values);
  const points = values.map((v, i) => [pad + (i / (values.length - 1)) * (W - 2 * pad), H - pad - (v / max) * (H - 2 * pad)]);
  const line = points.map((p) => p.join(",")).join(" ");
  const [endX, endY] = points[points.length - 1];
  return (
    <svg className="sparkline" viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={label}>
      <title>{label}</title>
      <polygon points={`${pad},${H - pad} ${line} ${W - pad},${H - pad}`} fill={color} opacity={0.1} />
      <polyline points={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={endX} cy={endY} r={4} fill={color} stroke="#fff" strokeWidth={2} />
    </svg>
  );
}
