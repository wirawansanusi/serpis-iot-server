"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatValue, resolveColor, type ChartType } from "@/lib/metrics";

// One plotted metric. `chartType` is the time-series shape (gauges are rendered
// separately via MetricGauge and never reach this component).
export type ChartSeries = {
  key: string;
  label: string;
  unit: string;
  precision: number;
  chartType: Exclude<ChartType, "gauge">;
  axis: "left" | "right";
  color: string | null;
  min: number | null;
  max: number | null;
};

// Wide rows keyed by timestamp: { t, temp_c: 22.5, humidity: 55.3, ... }.
export type ChartRow = { t: number } & Record<string, number | null>;

function readVarFn(): (name: string) => string {
  if (typeof window === "undefined") return () => "";
  const s = getComputedStyle(document.documentElement);
  return (name: string) => s.getPropertyValue(name);
}

function formatTick(ms: number, totalMs: number): string {
  const d = new Date(ms);
  if (totalMs <= 24 * 60 * 60 * 1000) {
    return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
  }
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function MetricChart({
  series,
  data,
}: {
  series: ChartSeries[];
  data: ChartRow[];
}) {
  // Resolve theme tokens to concrete colors, re-resolving on theme change.
  const [colors, setColors] = useState<{ series: Record<string, string>; grid: string; muted: string; text: string }>(
    () => resolveAll(series),
  );

  useEffect(() => {
    setColors(resolveAll(series));
    const observer = new MutationObserver(() => setColors(resolveAll(series)));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, [series]);

  const byKey = useMemo(() => Object.fromEntries(series.map((s) => [s.key, s])), [series]);

  if (data.length === 0 || series.length === 0) {
    return <div className="empty">No data in this range yet.</div>;
  }

  const totalMs = data[data.length - 1].t - data[0].t;
  const axes = { left: series.some((s) => s.axis === "left"), right: series.some((s) => s.axis === "right") };
  // The unit shown on each axis comes from its first series.
  const leftUnit = series.find((s) => s.axis === "left")?.unit ?? "";
  const rightUnit = series.find((s) => s.axis === "right")?.unit ?? "";

  return (
    <div style={{ width: "100%", height: 340 }}>
      <ResponsiveContainer>
        <ComposedChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
          <CartesianGrid stroke={colors.grid} strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="t"
            type="number"
            domain={["dataMin", "dataMax"]}
            tickFormatter={(v) => formatTick(v, totalMs)}
            stroke={colors.muted}
            tick={{ fontSize: 11, fill: colors.muted }}
          />
          {axes.left && (
            <YAxis
              yAxisId="left"
              stroke={colors.muted}
              tick={{ fontSize: 11, fill: colors.muted }}
              domain={[(min: number) => min - 2, (max: number) => max + 2]}
              width={46}
              tickFormatter={(v) => `${Math.round(v)}${leftUnit === "%" ? "%" : ""}`}
            />
          )}
          {axes.right && (
            <YAxis
              yAxisId="right"
              orientation="right"
              stroke={colors.muted}
              tick={{ fontSize: 11, fill: colors.muted }}
              domain={[(min: number) => min - 1, (max: number) => max + 1]}
              width={46}
              tickFormatter={(v) => `${Math.round(v)}${rightUnit === "%" ? "%" : ""}`}
            />
          )}
          <Tooltip
            contentStyle={{
              background: "var(--card)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              color: colors.text,
              fontSize: 12,
            }}
            labelFormatter={(v) => new Date(v as number).toLocaleString()}
            formatter={(value: number, name: string) => {
              const s = byKey[name];
              return s ? [formatValue(value, s), s.label] : [value, name];
            }}
          />
          <Legend
            wrapperStyle={{ fontSize: 12, color: colors.muted }}
            iconType="line"
            formatter={(value: string) => byKey[value]?.label ?? value}
          />

          {/* Threshold reference lines, one per bound that is set. */}
          {series.flatMap((s) =>
            [s.min, s.max]
              .filter((v): v is number => v !== null)
              .map((v, i) => (
                <ReferenceLine
                  key={`${s.key}-ref-${i}`}
                  yAxisId={s.axis}
                  y={v}
                  stroke={colors.series[s.key]}
                  strokeDasharray="4 4"
                  strokeOpacity={0.5}
                />
              )),
          )}

          {series.map((s) => {
            const common = {
              key: s.key,
              yAxisId: s.axis,
              dataKey: s.key,
              name: s.key,
              stroke: colors.series[s.key],
              isAnimationActive: false,
              connectNulls: true,
            } as const;
            if (s.chartType === "area") {
              return <Area {...common} type="monotone" fill={colors.series[s.key]} fillOpacity={0.15} strokeWidth={2} dot={false} />;
            }
            if (s.chartType === "bar") {
              return <Bar key={s.key} yAxisId={s.axis} dataKey={s.key} name={s.key} fill={colors.series[s.key]} isAnimationActive={false} />;
            }
            // line + state both render as lines; state steps between values.
            return (
              <Line
                {...common}
                type={s.chartType === "state" ? "stepAfter" : "monotone"}
                strokeWidth={2}
                dot={false}
              />
            );
          })}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function resolveAll(series: ChartSeries[]) {
  const getVar = readVarFn();
  const seriesColors: Record<string, string> = {};
  for (const s of series) seriesColors[s.key] = resolveColor(s.color, getVar);
  return {
    series: seriesColors,
    grid: getVar("--chart-grid").trim() || "#e6e9ec",
    muted: getVar("--muted").trim() || "#5a6470",
    text: getVar("--text").trim() || "#1a1a1a",
  };
}
