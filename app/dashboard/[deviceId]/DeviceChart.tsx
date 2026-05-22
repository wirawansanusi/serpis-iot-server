"use client";

import { useEffect, useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export type ChartPoint = {
  t: number; // ms epoch
  humidity: number;
  temp_c: number;
};

type ThemeColors = {
  text: string;
  muted: string;
  grid: string;
  humidity: string;
  temp: string;
  threshold: string;
};

function readThemeColors(): ThemeColors {
  if (typeof window === "undefined") {
    return {
      text: "#1a1a1a", muted: "#5a6470", grid: "#e6e9ec",
      humidity: "#0066ff", temp: "#b1322a", threshold: "#7a4d00",
    };
  }
  const s = getComputedStyle(document.documentElement);
  return {
    text: s.getPropertyValue("--text").trim() || "#1a1a1a",
    muted: s.getPropertyValue("--muted").trim() || "#5a6470",
    grid: s.getPropertyValue("--chart-grid").trim() || "#e6e9ec",
    humidity: s.getPropertyValue("--accent").trim() || "#0066ff",
    temp: s.getPropertyValue("--bad").trim() || "#b1322a",
    threshold: s.getPropertyValue("--warn").trim() || "#7a4d00",
  };
}

function formatTick(ms: number, totalMs: number): string {
  const d = new Date(ms);
  if (totalMs <= 24 * 60 * 60 * 1000) {
    return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
  }
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function DeviceChart({
  data,
  humidityMin,
  humidityMax,
}: {
  data: ChartPoint[];
  humidityMin: number;
  humidityMax: number;
}) {
  const [colors, setColors] = useState<ThemeColors>(() => readThemeColors());

  useEffect(() => {
    setColors(readThemeColors());
    const observer = new MutationObserver(() => setColors(readThemeColors()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  if (data.length === 0) {
    return <div className="empty">No data in this range yet.</div>;
  }

  const totalMs = data[data.length - 1].t - data[0].t;

  return (
    <div style={{ width: "100%", height: 340 }}>
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
          <CartesianGrid stroke={colors.grid} strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="t"
            type="number"
            domain={["dataMin", "dataMax"]}
            tickFormatter={(v) => formatTick(v, totalMs)}
            stroke={colors.muted}
            tick={{ fontSize: 11, fill: colors.muted }}
          />
          <YAxis
            yAxisId="hum"
            stroke={colors.humidity}
            tick={{ fontSize: 11, fill: colors.muted }}
            domain={["dataMin - 2", "dataMax + 2"]}
            width={42}
            tickFormatter={(v) => `${v.toFixed(0)}%`}
          />
          <YAxis
            yAxisId="temp"
            orientation="right"
            stroke={colors.temp}
            tick={{ fontSize: 11, fill: colors.muted }}
            domain={["dataMin - 1", "dataMax + 1"]}
            width={42}
            tickFormatter={(v) => `${v.toFixed(0)}°`}
          />
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
              if (name === "humidity") return [`${value.toFixed(1)}%`, "Humidity"];
              if (name === "temp_c") return [`${value.toFixed(1)} °C`, "Temperature"];
              return [value, name];
            }}
          />
          <Legend wrapperStyle={{ fontSize: 12, color: colors.muted }} iconType="line" />
          <ReferenceLine yAxisId="hum" y={humidityMin} stroke={colors.threshold} strokeDasharray="4 4" />
          <ReferenceLine yAxisId="hum" y={humidityMax} stroke={colors.threshold} strokeDasharray="4 4" />
          <Line
            yAxisId="hum"
            type="monotone"
            dataKey="humidity"
            stroke={colors.humidity}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
            name="humidity"
          />
          <Line
            yAxisId="temp"
            type="monotone"
            dataKey="temp_c"
            stroke={colors.temp}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
            name="temp_c"
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
