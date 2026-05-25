// Shared metric types + helpers used by the ingest route, the dashboard pages,
// and the chart components. A "metric" is a self-describing measurement a device
// reports (temp_c, humidity, co2, ...). Its display/viz config lives in the
// `metrics` registry table; per-device alert bounds live in
// `device_metric_thresholds`.

export type ChartType = "line" | "area" | "gauge" | "bar" | "state";

// One row of the `metrics` registry.
export type MetricDef = {
  key: string;
  label: string;
  unit: string;
  precision: number;
  chart_type: ChartType;
  axis: "left" | "right";
  color: string | null;
  sort_order: number;
};

// A metric as it applies to a specific device: registry def + that device's
// alert bounds. This is what the device page renders from.
export type DeviceMetric = MetricDef & {
  min_val: number | null;
  max_val: number | null;
};

// Theme tokens that resolve to CSS variables so a metric's color adapts to
// light/dark mode. Anything else in `color` is treated as a literal CSS color.
const THEME_TOKENS: Record<string, string> = {
  accent: "--accent",
  bad: "--bad",
  good: "--good",
  warn: "--warn",
};

// Fallbacks for when CSS vars can't be read (server render, or var unset).
const FALLBACK_HEX: Record<string, string> = {
  accent: "#4d9fff",
  bad: "#ef6b63",
  good: "#3ec07a",
  warn: "#f0c46a",
};

// Resolve a metric color to a concrete value usable as an SVG stroke/fill.
// `getVar` reads a CSS variable (getComputedStyle on the client); when absent
// (server) theme tokens fall back to a fixed hex.
export function resolveColor(
  color: string | null,
  getVar?: (name: string) => string,
): string {
  if (!color) {
    const v = getVar?.("--accent")?.trim();
    return v && v.length > 0 ? v : FALLBACK_HEX.accent;
  }
  const cssVar = THEME_TOKENS[color];
  if (cssVar) {
    const v = getVar?.(cssVar)?.trim();
    return v && v.length > 0 ? v : FALLBACK_HEX[color];
  }
  return color; // literal hex / CSS color
}

// "temp_c" -> "Temp C", "co2" -> "Co2". Used to label auto-registered metrics
// that arrived without a label hint.
export function humanizeKey(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// Format a value with its unit and precision. "%" hugs the number; other units
// (°C, ppm, hPa, ...) get a thin space.
export function formatValue(
  value: number,
  m: { unit: string; precision: number },
): string {
  const n = value.toFixed(m.precision);
  if (!m.unit) return n;
  return m.unit === "%" ? `${n}%` : `${n} ${m.unit}`;
}
