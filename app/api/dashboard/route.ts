import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { supabase } from "@/lib/supabase";
import { buildMobileFirmware } from "@/lib/ota";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const DAY_MS = 24 * 60 * 60 * 1000;
const STATUS_METRIC_KEYS = new Set(["battery_mv", "power_mv", "battery_percent"]);

type Range = "1h" | "6h" | "24h" | "7d" | "30d";

const RANGE_MS: Record<Range, number> = {
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

type DeviceRow = {
  id: string;
  mac: string | null;
  name: string | null;
  device_type: string | null;
  last_seen: string;
  firmware_version: string | null;
  battery_percent: number | null;
  battery_mv: number | null;
  power_source: string | null;
  report_interval_minutes: number | null;
  link_online: boolean | null;
};

type MetricDef = {
  key: string;
  label: string;
  unit: string;
  precision: number;
  chart_type: "line" | "area" | "gauge" | "bar" | "state";
  axis: "left" | "right";
  color: string | null;
  sort_order: number;
};

type DeviceMetric = MetricDef & {
  min_val: number | null;
  max_val: number | null;
};

type MetricStats = {
  metric_key: string;
  latest: number | null;
  latest_at: string | null;
  min: number | null;
  max: number | null;
};

type ChartRow = { t: number } & Record<string, number | null>;

function parseRange(raw: string | null): Range {
  if (raw === "1h" || raw === "6h" || raw === "24h" || raw === "7d" || raw === "30d") return raw;
  return "24h";
}

// A deep-sleeping device is only awake to check in once per report interval, so
// the "offline" grace period has to scale with it — otherwise a 60-min reporter
// always looks offline. window = 2 intervals + 5 min slack; at the default
// 5 min this is 15 min, matching the original fixed window.
function onlineWindowMs(reportMinutes: number | null): number {
  const minutes = reportMinutes ?? 5;
  return (minutes * 2 + 5) * 60 * 1000;
}

// link_online is the MQTT Last-Will signal (always-on devices): false => the
// broker saw the connection drop, so it's offline NOW regardless of freshness.
// null (HTTP-only sensors) falls back to pure freshness.
function online(lastSeen: string, reportMinutes: number | null, linkOnline?: boolean | null): boolean {
  if (linkOnline === false) return false;
  return Date.now() - new Date(lastSeen).getTime() < onlineWindowMs(reportMinutes);
}

function metricFromRow(row: any): DeviceMetric | null {
  const metric = row.metrics;
  if (!metric || STATUS_METRIC_KEYS.has(metric.key)) return null;
  return {
    key: metric.key,
    label: metric.label,
    unit: metric.unit,
    precision: metric.precision,
    chart_type: metric.chart_type,
    axis: metric.axis,
    color: metric.color,
    sort_order: metric.sort_order,
    min_val: row.min_val,
    max_val: row.max_val,
  };
}

function sample<T>(rows: T[], maxRows: number): T[] {
  if (rows.length <= maxRows) return rows;
  const step = (rows.length - 1) / (maxRows - 1);
  return Array.from({ length: maxRows }, (_, i) => rows[Math.round(i * step)]);
}

export async function GET(req: NextRequest) {
  const { userId } = auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const range = parseRange(url.searchParams.get("range"));
  const requestedDeviceId = url.searchParams.get("device_id");
  const sinceIso = new Date(Date.now() - RANGE_MS[range]).toISOString();
  const dayIso = new Date(Date.now() - DAY_MS).toISOString();

  const { data: deviceRows, error: devicesError } = await supabase
    .from("devices")
    .select("id, mac, name, device_type, last_seen, firmware_version, battery_percent, battery_mv, power_source, report_interval_minutes, link_online")
    .eq("owner_user_id", userId)
    .order("last_seen", { ascending: false });

  if (devicesError) {
    console.error("[api/dashboard] devices", devicesError);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }

  const rawDevices = (deviceRows ?? []) as DeviceRow[];
  if (rawDevices.length === 0) {
    return NextResponse.json({ range, devices: [], selected_device_id: null, detail: null });
  }

  const selectedDevice =
    (requestedDeviceId ? rawDevices.find((device) => device.id === requestedDeviceId) : rawDevices[0]) ?? null;
  if (!selectedDevice) {
    return NextResponse.json({ error: "device_not_found" }, { status: 404 });
  }

  const deviceIds = rawDevices.map((device) => device.id);
  const { data: metricRows, error: metricsError } = await supabase
    .from("device_metric_thresholds")
    .select("device_id, metric_key, min_val, max_val, metrics(key, label, unit, precision, chart_type, axis, color, sort_order)")
    .in("device_id", deviceIds);

  if (metricsError) {
    console.error("[api/dashboard] metrics", metricsError);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }

  const metricsByDevice = new Map<string, DeviceMetric[]>();
  for (const row of (metricRows ?? []) as any[]) {
    const metric = metricFromRow(row);
    if (!metric) continue;
    const existing = metricsByDevice.get(row.device_id);
    if (existing) existing.push(metric);
    else metricsByDevice.set(row.device_id, [metric]);
  }
  for (const metrics of metricsByDevice.values()) {
    metrics.sort((a, b) => a.sort_order - b.sort_order);
  }

  const primaryByDevice = new Map<string, DeviceMetric>();
  for (const [deviceId, metrics] of metricsByDevice.entries()) {
    if (metrics[0]) primaryByDevice.set(deviceId, metrics[0]);
  }

  const primaryKeys = Array.from(new Set([...primaryByDevice.values()].map((metric) => metric.key)));
  const primaryRows =
    primaryKeys.length === 0
      ? []
      : ((await supabase
          .from("readings")
          .select("device_id, metric_key, value, recorded_at")
          .in("device_id", deviceIds)
          .in("metric_key", primaryKeys)
          .gte("recorded_at", dayIso)
          .order("recorded_at", { ascending: true })).data ?? []);

  const primaryReadings = new Map<string, { value: number; recorded_at: string }[]>();
  for (const row of primaryRows as { device_id: string; metric_key: string; value: number; recorded_at: string }[]) {
    const primary = primaryByDevice.get(row.device_id);
    if (!primary || row.metric_key !== primary.key) continue;
    const existing = primaryReadings.get(row.device_id);
    if (existing) existing.push({ value: row.value, recorded_at: row.recorded_at });
    else primaryReadings.set(row.device_id, [{ value: row.value, recorded_at: row.recorded_at }]);
  }

  const { data: openEventRows } = await supabase
    .from("events")
    .select("device_id")
    .in("device_id", deviceIds)
    .is("ended_at", null);
  const openEventsByDevice = new Map<string, number>();
  for (const row of (openEventRows ?? []) as { device_id: string }[]) {
    openEventsByDevice.set(row.device_id, (openEventsByDevice.get(row.device_id) ?? 0) + 1);
  }

  const devices = rawDevices.map((device) => {
    const primary = primaryByDevice.get(device.id) ?? null;
    const readings = primaryReadings.get(device.id) ?? [];
    const latest = readings[readings.length - 1] ?? null;
    const hasBounds = primary != null && (primary.min_val !== null || primary.max_val !== null);
    const inRange = primary
      ? readings.filter(
          (reading) =>
            (primary.min_val === null || reading.value >= primary.min_val) &&
            (primary.max_val === null || reading.value <= primary.max_val),
        ).length
      : 0;

    return {
      id: device.id,
      mac: device.mac,
      name: device.name,
      device_type: device.device_type,
      last_seen: device.last_seen,
      online: online(device.last_seen, device.report_interval_minutes, device.link_online),
      battery_percent: device.battery_percent,
      battery_mv: device.battery_mv,
      power_source: device.power_source,
      report_interval_minutes: device.report_interval_minutes,
      open_event_count: openEventsByDevice.get(device.id) ?? 0,
      primary: primary
        ? {
            key: primary.key,
            label: primary.label,
            unit: primary.unit,
            precision: primary.precision,
            latest: latest?.value ?? null,
            latest_at: latest?.recorded_at ?? null,
            compliance_percent:
              hasBounds && readings.length > 0 ? Math.round((inRange / readings.length) * 100) : null,
            sparkline: sample(readings, 32).map((reading) => ({ t: new Date(reading.recorded_at).getTime(), value: reading.value })),
          }
        : null,
    };
  });

  const selectedMetrics = metricsByDevice.get(selectedDevice.id) ?? [];
  const selectedMetricKeys = selectedMetrics.map((metric) => metric.key);
  const timeSeriesMetrics = selectedMetrics.filter((metric) => metric.chart_type !== "gauge");
  const chartKeys = timeSeriesMetrics.map((metric) => metric.key);
  const useHourly = range === "7d" || range === "30d";
  let chartData: ChartRow[] = [];

  if (chartKeys.length > 0) {
    const chartRes = useHourly
      ? await supabase
          .from("readings_hourly")
          .select("hour, metric_key, val_avg")
          .eq("device_id", selectedDevice.id)
          .in("metric_key", chartKeys)
          .gte("hour", sinceIso)
          .order("hour", { ascending: true })
      : await supabase
          .from("readings")
          .select("recorded_at, metric_key, value")
          .eq("device_id", selectedDevice.id)
          .in("metric_key", chartKeys)
          .gte("recorded_at", sinceIso)
          .order("recorded_at", { ascending: true });

    if (chartRes.error) {
      console.error("[api/dashboard] chart", chartRes.error);
      return NextResponse.json({ error: "server_error" }, { status: 500 });
    }

    const rowMap = new Map<number, ChartRow>();
    for (const row of (chartRes.data ?? []) as any[]) {
      const t = new Date(useHourly ? row.hour : row.recorded_at).getTime();
      let chartRow = rowMap.get(t);
      if (!chartRow) {
        chartRow = { t };
        rowMap.set(t, chartRow);
      }
      chartRow[row.metric_key] = useHourly ? row.val_avg : row.value;
    }
    chartData = sample(Array.from(rowMap.values()).sort((a, b) => a.t - b.t), 180);
  }

  const statsRows =
    selectedMetricKeys.length === 0
      ? []
      : ((await supabase
          .from("readings")
          .select("metric_key, value, recorded_at")
          .eq("device_id", selectedDevice.id)
          .in("metric_key", selectedMetricKeys)
          .gte("recorded_at", dayIso)).data ?? []);

  const statsMap = new Map<string, MetricStats>();
  for (const row of statsRows as { metric_key: string; value: number; recorded_at: string }[]) {
    const current = statsMap.get(row.metric_key) ?? {
      metric_key: row.metric_key,
      latest: null,
      latest_at: null,
      min: row.value,
      max: row.value,
    };
    if (current.latest_at === null || row.recorded_at > current.latest_at) {
      current.latest = row.value;
      current.latest_at = row.recorded_at;
    }
    current.min = current.min === null ? row.value : Math.min(current.min, row.value);
    current.max = current.max === null ? row.value : Math.max(current.max, row.value);
    statsMap.set(row.metric_key, current);
  }

  const { data: eventRows, error: eventsError } = await supabase
    .from("events")
    .select("id, metric_key, direction, started_at, ended_at, peak_value, threshold, metrics(label, unit, precision)")
    .eq("device_id", selectedDevice.id)
    .order("started_at", { ascending: false })
    .limit(50);

  if (eventsError) {
    console.error("[api/dashboard] events", eventsError);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }

  const firmware = await buildMobileFirmware(selectedDevice);

  // Notification preferences for the selected device (defaults when never set).
  const { data: notifRow } = await supabase
    .from("device_notification_settings")
    .select("enabled, use_profile, alert_low, alert_high, cadence, tz_offset_minutes")
    .eq("device_id", selectedDevice.id)
    .maybeSingle();
  const notifications = notifRow ?? {
    enabled: false,
    use_profile: true,
    alert_low: null,
    alert_high: null,
    cadence: "balanced",
    tz_offset_minutes: 0,
  };

  return NextResponse.json({
    range,
    devices,
    selected_device_id: selectedDevice.id,
    detail: {
      device: {
        id: selectedDevice.id,
        mac: selectedDevice.mac,
        name: selectedDevice.name,
        device_type: selectedDevice.device_type,
        last_seen: selectedDevice.last_seen,
        online: online(selectedDevice.last_seen, selectedDevice.report_interval_minutes, selectedDevice.link_online),
        battery_percent: selectedDevice.battery_percent,
        battery_mv: selectedDevice.battery_mv,
        power_source: selectedDevice.power_source,
        report_interval_minutes: selectedDevice.report_interval_minutes,
        open_event_count: openEventsByDevice.get(selectedDevice.id) ?? 0,
      },
      firmware,
      notifications,
      metrics: selectedMetrics,
      stats: selectedMetrics.map(
        (metric) =>
          statsMap.get(metric.key) ?? {
            metric_key: metric.key,
            latest: null,
            latest_at: null,
            min: null,
            max: null,
          },
      ),
      chart: {
        series: timeSeriesMetrics.map((metric) => ({
          key: metric.key,
          label: metric.label,
          unit: metric.unit,
          precision: metric.precision,
          chart_type: metric.chart_type,
          axis: metric.axis,
          color: metric.color,
          min_val: metric.min_val,
          max_val: metric.max_val,
        })),
        data: chartData,
      },
      events: (eventRows ?? []).map((event: any) => ({
        id: event.id,
        metric_key: event.metric_key,
        direction: event.direction,
        started_at: event.started_at,
        ended_at: event.ended_at,
        peak_value: event.peak_value,
        threshold: event.threshold,
        metric: event.metrics,
      })),
    },
  });
}
