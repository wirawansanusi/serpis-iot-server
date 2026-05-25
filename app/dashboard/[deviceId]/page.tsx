import { notFound, redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { supabase } from "@/lib/supabase";
import { formatValue, type DeviceMetric } from "@/lib/metrics";
import { MetricChart, type ChartRow, type ChartSeries } from "./MetricChart";
import { MetricGauge } from "./MetricGauge";
import { BatteryIndicator } from "./BatteryIndicator";
import { RangeSelector, type Range } from "./RangeSelector";
import { DeviceActions } from "../DeviceActions";
import { ThresholdSettings } from "../ThresholdSettings";
import { AutoRefresh } from "../AutoRefresh";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const ONLINE_WINDOW_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

type Device = {
  id: string;
  mac: string;
  name: string | null;
  device_type: string | null;
  last_seen: string;
  battery_percent: number | null;
  battery_mv: number | null;
  power_source: string | null;
};

// Battery is rendered as a status indicator, not a chart metric — exclude any
// residual battery metric keys from the trend chart and stat cards.
const STATUS_METRIC_KEYS = new Set(["battery_mv", "power_mv", "battery_percent"]);

type EventRow = {
  id: number;
  metric_key: string;
  direction: "high" | "low";
  started_at: string;
  ended_at: string | null;
  peak_value: number;
  threshold: number;
  metrics: { label: string; unit: string; precision: number } | null;
};

const RANGE_MS: Record<Range, number> = {
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

function parseRange(r: string | undefined): Range {
  if (r === "1h" || r === "6h" || r === "24h" || r === "7d" || r === "30d") return r;
  return "24h";
}

function formatDuration(start: string, end: string | null): string {
  const ms = (end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round((ms / 3_600_000) * 10) / 10}h`;
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

// Latest value + 24h min/max for one metric, derived from the last-24h readings.
type MetricStats = { latest: number | null; latestAt: string | null; min: number | null; max: number | null };

export default async function DevicePage({
  params,
  searchParams,
}: {
  params: { deviceId: string };
  searchParams: { range?: string };
}) {
  const { userId } = auth();
  if (!userId) redirect("/sign-in");

  const range = parseRange(searchParams.range);
  const sinceIso = new Date(Date.now() - RANGE_MS[range]).toISOString();
  const day1Iso = new Date(Date.now() - DAY_MS).toISOString();

  const { data: device } = await supabase
    .from("devices")
    .select("id, mac, name, device_type, last_seen, battery_percent, battery_mv, power_source")
    .eq("id", params.deviceId)
    .eq("owner_user_id", userId)
    .maybeSingle<Device>();

  // If the device doesn't exist or doesn't belong to this user, treat as 404.
  if (!device) notFound();

  // The device's metric inventory + viz config + thresholds, in one join.
  const { data: dmRows } = await supabase
    .from("device_metric_thresholds")
    .select("metric_key, min_val, max_val, metrics(key, label, unit, precision, chart_type, axis, color, sort_order)")
    .eq("device_id", device.id);

  const deviceMetrics: DeviceMetric[] = (dmRows ?? [])
    .map((r: any) => ({
      key: r.metrics.key,
      label: r.metrics.label,
      unit: r.metrics.unit,
      precision: r.metrics.precision,
      chart_type: r.metrics.chart_type,
      axis: r.metrics.axis,
      color: r.metrics.color,
      sort_order: r.metrics.sort_order,
      min_val: r.min_val,
      max_val: r.max_val,
    }))
    .filter((m) => !STATUS_METRIC_KEYS.has(m.key))  // battery shown as a status indicator instead
    .sort((a, b) => a.sort_order - b.sort_order);

  const timeSeriesMetrics = deviceMetrics.filter((m) => m.chart_type !== "gauge");

  // Chart rows for the selected range: raw readings <=24h, hourly rollups beyond.
  const useHourly = range === "7d" || range === "30d";
  const chartKeys = timeSeriesMetrics.map((m) => m.key);
  let chartData: ChartRow[] = [];
  if (chartKeys.length > 0) {
    const chartRes = useHourly
      ? await supabase
          .from("readings_hourly")
          .select("hour, metric_key, val_avg")
          .eq("device_id", device.id)
          .in("metric_key", chartKeys)
          .gte("hour", sinceIso)
          .order("hour", { ascending: true })
      : await supabase
          .from("readings")
          .select("recorded_at, metric_key, value")
          .eq("device_id", device.id)
          .in("metric_key", chartKeys)
          .gte("recorded_at", sinceIso)
          .order("recorded_at", { ascending: true });

    const rowMap = new Map<number, ChartRow>();
    for (const r of (chartRes.data ?? []) as any[]) {
      const t = new Date(useHourly ? r.hour : r.recorded_at).getTime();
      let row = rowMap.get(t);
      if (!row) {
        row = { t };
        rowMap.set(t, row);
      }
      row[r.metric_key] = useHourly ? r.val_avg : r.value;
    }
    chartData = Array.from(rowMap.values()).sort((a, b) => a.t - b.t);
  }

  const chartSeries: ChartSeries[] = timeSeriesMetrics.map((m) => ({
    key: m.key,
    label: m.label,
    unit: m.unit,
    precision: m.precision,
    chartType: m.chart_type as ChartSeries["chartType"],
    axis: m.axis,
    color: m.color,
    min: m.min_val,
    max: m.max_val,
  }));

  // 24h stats per metric (latest value, 24h min/max), independent of range.
  const { data: dayRows } = await supabase
    .from("readings")
    .select("metric_key, value, recorded_at")
    .eq("device_id", device.id)
    .gte("recorded_at", day1Iso);

  const stats = new Map<string, MetricStats>();
  for (const r of (dayRows ?? []) as { metric_key: string; value: number; recorded_at: string }[]) {
    const s = stats.get(r.metric_key) ?? { latest: null, latestAt: null, min: r.value, max: r.value };
    if (s.latestAt === null || r.recorded_at > s.latestAt) {
      s.latest = r.value;
      s.latestAt = r.recorded_at;
    }
    s.min = s.min === null ? r.value : Math.min(s.min, r.value);
    s.max = s.max === null ? r.value : Math.max(s.max, r.value);
    stats.set(r.metric_key, s);
  }
  const statFor = (key: string): MetricStats => stats.get(key) ?? { latest: null, latestAt: null, min: null, max: null };

  // Recent events for this device (50 most recent).
  const { data: eventRows } = await supabase
    .from("events")
    .select("id, metric_key, direction, started_at, ended_at, peak_value, threshold, metrics(label, unit, precision)")
    .eq("device_id", device.id)
    .order("started_at", { ascending: false })
    .limit(50);
  const events: EventRow[] = (eventRows as any) ?? [];
  const openEvents = events.filter((e) => e.ended_at === null);

  const online = Date.now() - new Date(device.last_seen).getTime() < ONLINE_WINDOW_MS;

  return (
    <>
      <AutoRefresh seconds={30} />

      <DeviceActions id={device.id} name={device.name} mac={device.mac} />
      {device.device_type && (
        <div className="sub" style={{ marginBottom: 8 }}>type: {device.device_type}</div>
      )}

      <div className="pills">
        <span className={`pill ${online ? "good" : "muted"}`}>
          <span className="dot" /> {online ? "Connected" : "Disconnected"}
        </span>
        <span className={`pill ${openEvents.length === 0 ? "good" : "bad"}`}>
          <span className="dot" /> {openEvents.length === 0 ? "Normal" : `${openEvents.length} open incident${openEvents.length > 1 ? "s" : ""}`}
        </span>
        <span className="pill muted">last seen {formatRelative(device.last_seen)}</span>
      </div>

      <div className="stats">
        {(device.power_source !== null || device.battery_percent !== null) && (
          <BatteryIndicator
            percent={device.battery_percent}
            powerSource={device.power_source}
            mv={device.battery_mv}
          />
        )}
        {deviceMetrics.map((m) => {
          const s = statFor(m.key);
          if (m.chart_type === "gauge") {
            return (
              <MetricGauge
                key={m.key}
                label={m.label}
                unit={m.unit}
                precision={m.precision}
                value={s.latest}
                min={m.min_val}
                max={m.max_val}
              />
            );
          }
          return (
            <div className="stat" key={m.key}>
              <div className="label">{m.label}</div>
              <div className="value">{s.latest !== null ? formatValue(s.latest, m) : "—"}</div>
              <div className="sub">{s.latestAt ? formatRelative(s.latestAt) : "no data"}</div>
              {s.min !== null && s.max !== null && (
                <div className="sub">24h {formatValue(s.min, m)}–{formatValue(s.max, m)}</div>
              )}
            </div>
          );
        })}
      </div>
      {deviceMetrics.length === 0 && (
        <div className="empty">No sensor metrics reported yet. Power on the device and wait for its first reading.</div>
      )}

      {chartSeries.length > 0 && (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
            <h2 className="section" style={{ margin: 0 }}>Trend</h2>
            <RangeSelector active={range} />
          </div>
          <div className="chart-card">
            <MetricChart series={chartSeries} data={chartData} />
          </div>
        </>
      )}

      {deviceMetrics.length > 0 && <ThresholdSettings deviceId={device.id} metrics={deviceMetrics} />}

      <h2 className="section">Recent events</h2>
      {events.length === 0 ? (
        <div className="empty">No abnormal events recorded for this device.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Metric</th>
              <th>Started</th>
              <th>Ended</th>
              <th>Duration</th>
              <th>Peak</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => {
              const unit = e.metrics?.unit ?? "";
              const precision = e.metrics?.precision ?? 1;
              return (
                <tr key={e.id}>
                  <td className="kind">{`${e.metrics?.label ?? e.metric_key} ${e.direction}`}</td>
                  <td>{new Date(e.started_at).toLocaleString()}</td>
                  <td>{e.ended_at ? new Date(e.ended_at).toLocaleString() : "ongoing"}</td>
                  <td>{formatDuration(e.started_at, e.ended_at)}</td>
                  <td>{formatValue(e.peak_value, { unit, precision })}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}
