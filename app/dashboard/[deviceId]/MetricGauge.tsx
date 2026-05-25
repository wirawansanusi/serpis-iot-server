"use client";

import { formatValue } from "@/lib/metrics";

// A horizontal bar gauge for a single metric's latest value. The fill is green
// while the value sits within its thresholds and red when it breaches them;
// small ticks mark the min/max bounds. Used for metrics whose chart_type is
// 'gauge'. Rendered as a .stat card so it sits in the stats grid.
export function MetricGauge({
  label,
  unit,
  precision,
  value,
  min,
  max,
}: {
  label: string;
  unit: string;
  precision: number;
  value: number | null;
  min: number | null;
  max: number | null;
}) {
  if (value === null) {
    return (
      <div className="stat">
        <div className="label">{label}</div>
        <div className="value">—</div>
        <div className="sub">no data</div>
      </div>
    );
  }

  // Percentage metrics (battery %, humidity %) always read on a 0–100 scale;
  // other gauges derive a range from thresholds or the value itself.
  const isPercent = unit === "%";
  const lo = isPercent ? 0 : min !== null ? Math.min(min, value) : Math.min(0, value);
  let hi = isPercent ? 100 : max !== null ? Math.max(max, value) : value > 0 ? value * 1.5 : 1;
  if (hi <= lo) hi = lo + 1;

  const frac = Math.max(0, Math.min(1, (value - lo) / (hi - lo)));
  const inRange = (min === null || value >= min) && (max === null || value <= max);
  const pos = (x: number) => `${(((x - lo) / (hi - lo)) * 100).toFixed(1)}%`;
  const endLabel = (x: number) => `${Math.round(x)}${unit === "%" ? "%" : ""}`;

  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{formatValue(value, { unit, precision })}</div>
      <div className="gauge-track">
        <div
          className="gauge-fill"
          style={{ width: `${(frac * 100).toFixed(1)}%`, background: inRange ? "var(--good)" : "var(--bad)" }}
        />
        {min !== null && <span className="gauge-mark" style={{ left: pos(min) }} />}
        {max !== null && <span className="gauge-mark" style={{ left: pos(max) }} />}
      </div>
      <div className="gauge-ends">
        <span>{endLabel(lo)}</span>
        <span>{endLabel(hi)}</span>
      </div>
    </div>
  );
}
