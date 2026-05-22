import { notFound, redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { supabase } from "@/lib/supabase";
import { DeviceChart, type ChartPoint } from "./DeviceChart";
import { RangeSelector, type Range } from "./RangeSelector";
import { DeviceActions } from "../DeviceActions";
import { AutoRefresh } from "../AutoRefresh";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const ONLINE_WINDOW_MS = 15 * 60 * 1000;

type Device = {
  id: string;
  mac: string;
  name: string | null;
  humidity_min: number;
  humidity_max: number;
  temp_min: number;
  temp_max: number;
  last_seen: string;
};

type EventRow = {
  id: number;
  kind: "humidity_high" | "humidity_low" | "temp_high" | "temp_low";
  started_at: string;
  ended_at: string | null;
  peak_value: number;
  threshold: number;
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

function kindLabel(kind: EventRow["kind"]): string {
  switch (kind) {
    case "humidity_high": return "Humidity high";
    case "humidity_low":  return "Humidity low";
    case "temp_high":     return "Temperature high";
    case "temp_low":      return "Temperature low";
  }
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
  const sinceMs = Date.now() - RANGE_MS[range];
  const sinceIso = new Date(sinceMs).toISOString();
  const day1Iso = new Date(Date.now() - RANGE_MS["24h"]).toISOString();

  const { data: device } = await supabase
    .from("devices")
    .select("*")
    .eq("id", params.deviceId)
    .eq("owner_user_id", userId)
    .maybeSingle<Device>();

  // If the device doesn't exist or doesn't belong to this user, treat as 404.
  if (!device) notFound();

  // Chart data: use raw readings for <=24h, hourly rollups beyond.
  const useHourly = range === "7d" || range === "30d";
  const chartRes = useHourly
    ? await supabase
        .from("readings_hourly")
        .select("hour, hum_avg, temp_avg")
        .eq("device_id", device.id)
        .gte("hour", sinceIso)
        .order("hour", { ascending: true })
    : await supabase
        .from("readings")
        .select("recorded_at, humidity, temp_c")
        .eq("device_id", device.id)
        .gte("recorded_at", sinceIso)
        .order("recorded_at", { ascending: true });

  const chartData: ChartPoint[] = useHourly
    ? (chartRes.data ?? []).map((r: any) => ({
        t: new Date(r.hour).getTime(),
        humidity: r.hum_avg,
        temp_c: r.temp_avg,
      }))
    : (chartRes.data ?? []).map((r: any) => ({
        t: new Date(r.recorded_at).getTime(),
        humidity: r.humidity,
        temp_c: r.temp_c,
      }));

  // 24h stats (independent of selected range)
  const { data: dayRows } = await supabase
    .from("readings")
    .select("humidity, temp_c, recorded_at")
    .eq("device_id", device.id)
    .gte("recorded_at", day1Iso);

  const day = (dayRows ?? []) as { humidity: number; temp_c: number; recorded_at: string }[];
  const latest = day.length > 0 ? day.reduce((a, b) => (a.recorded_at > b.recorded_at ? a : b)) : null;
  const humMin = day.length ? Math.min(...day.map((r) => r.humidity)) : null;
  const humMax = day.length ? Math.max(...day.map((r) => r.humidity)) : null;
  const tempMin = day.length ? Math.min(...day.map((r) => r.temp_c)) : null;
  const tempMax = day.length ? Math.max(...day.map((r) => r.temp_c)) : null;

  // Events for this device (recent 50, open ones first conceptually)
  const { data: eventRows } = await supabase
    .from("events")
    .select("id, kind, started_at, ended_at, peak_value, threshold")
    .eq("device_id", device.id)
    .order("started_at", { ascending: false })
    .limit(50);
  const events: EventRow[] = eventRows ?? [];
  const openEvents = events.filter((e) => e.ended_at === null);

  const online = Date.now() - new Date(device.last_seen).getTime() < ONLINE_WINDOW_MS;

  return (
    <>
      <AutoRefresh seconds={30} />

      <DeviceActions id={device.id} name={device.name} mac={device.mac} />

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
        <div className="stat">
          <div className="label">Humidity</div>
          <div className="value">{latest ? `${latest.humidity.toFixed(1)}%` : "—"}</div>
          <div className="sub">{latest ? formatRelative(latest.recorded_at) : "no data"}</div>
        </div>
        <div className="stat">
          <div className="label">Temperature</div>
          <div className="value">{latest ? `${latest.temp_c.toFixed(1)} °C` : "—"}</div>
          <div className="sub">{latest ? formatRelative(latest.recorded_at) : "no data"}</div>
        </div>
        <div className="stat">
          <div className="label">24h humidity</div>
          <div className="value">
            {humMin !== null && humMax !== null ? `${humMin.toFixed(1)}–${humMax.toFixed(1)}%` : "—"}
          </div>
          <div className="sub">range</div>
        </div>
        <div className="stat">
          <div className="label">24h temp</div>
          <div className="value">
            {tempMin !== null && tempMax !== null ? `${tempMin.toFixed(1)}–${tempMax.toFixed(1)} °C` : "—"}
          </div>
          <div className="sub">range</div>
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
        <h2 className="section" style={{ margin: 0 }}>Trend</h2>
        <RangeSelector active={range} />
      </div>
      <div className="chart-card">
        <DeviceChart
          data={chartData}
          humidityMin={device.humidity_min}
          humidityMax={device.humidity_max}
        />
      </div>

      <h2 className="section">Recent events</h2>
      {events.length === 0 ? (
        <div className="empty">No abnormal events recorded for this device.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Kind</th>
              <th>Started</th>
              <th>Ended</th>
              <th>Duration</th>
              <th>Peak</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id}>
                <td className="kind">{kindLabel(e.kind)}</td>
                <td>{new Date(e.started_at).toLocaleString()}</td>
                <td>{e.ended_at ? new Date(e.ended_at).toLocaleString() : "ongoing"}</td>
                <td>{formatDuration(e.started_at, e.ended_at)}</td>
                <td>{e.peak_value.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
