import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { isAdminUser } from "@/lib/admin";
import { SidebarLink } from "./SidebarLink";

const DAY_MS = 24 * 60 * 60 * 1000;
const ONLINE_WINDOW_MS = 15 * 60 * 1000;

type Device = {
  id: string;
  mac: string;
  name: string | null;
  last_seen: string;
};

// The metric a device is summarized by in the sidebar: its lowest-sort_order
// metric, plus that metric's alert bounds for the compliance %.
type Primary = { key: string; min: number | null; max: number | null; order: number };

function sparklinePath(values: number[], width: number, height: number): string {
  if (values.length === 0) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  return values
    .map((v, i) => {
      const x = i * step;
      const y = height - ((v - min) / range) * height;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

export async function Sidebar({ userId }: { userId: string }) {
  const sinceDay = new Date(Date.now() - DAY_MS).toISOString();

  const { data: devicesData } = await supabase
    .from("devices")
    .select("id, mac, name, last_seen")
    .eq("owner_user_id", userId)
    .order("last_seen", { ascending: false });
  const devices: Device[] = devicesData ?? [];
  const deviceIds = devices.map((d) => d.id);

  // Pick each device's primary metric (lowest sort_order) from its thresholds.
  const primary = new Map<string, Primary>();
  if (deviceIds.length > 0) {
    const { data: dmRows } = await supabase
      .from("device_metric_thresholds")
      .select("device_id, metric_key, min_val, max_val, metrics(sort_order)")
      .in("device_id", deviceIds);
    for (const r of (dmRows ?? []) as any[]) {
      const order = r.metrics?.sort_order ?? 999;
      const cur = primary.get(r.device_id);
      if (!cur || order < cur.order) {
        primary.set(r.device_id, { key: r.metric_key, min: r.min_val, max: r.max_val, order });
      }
    }
  }

  // Fetch last-24h readings for the primary metrics, then keep per device only
  // the rows matching that device's own primary metric.
  const primaryKeys = Array.from(new Set([...primary.values()].map((p) => p.key)));
  const readings =
    deviceIds.length === 0 || primaryKeys.length === 0
      ? []
      : ((
          await supabase
            .from("readings")
            .select("device_id, metric_key, value, recorded_at")
            .in("device_id", deviceIds)
            .in("metric_key", primaryKeys)
            .gte("recorded_at", sinceDay)
        ).data ?? []);

  const byDevice = new Map<string, { value: number; recorded_at: string }[]>();
  for (const r of readings as { device_id: string; metric_key: string; value: number; recorded_at: string }[]) {
    const p = primary.get(r.device_id);
    if (!p || r.metric_key !== p.key) continue;
    const arr = byDevice.get(r.device_id);
    if (arr) arr.push({ value: r.value, recorded_at: r.recorded_at });
    else byDevice.set(r.device_id, [{ value: r.value, recorded_at: r.recorded_at }]);
  }
  for (const arr of byDevice.values()) {
    arr.sort((a, b) => (a.recorded_at < b.recorded_at ? -1 : 1));
  }

  return (
    <aside className="sidebar">
      <h2>Devices</h2>
      <Link href="/dashboard/claim" className="add-btn">+ Add device</Link>
      {isAdminUser(userId) ? (
        <Link href="/dashboard/firmware" className="add-btn" style={{ background: "transparent", color: "var(--accent)", border: "1px solid var(--border)" }}>
          Firmware
        </Link>
      ) : null}
      <nav>
        {devices.length === 0 ? (
          <p className="empty">No devices yet.</p>
        ) : (
          devices.map((d) => {
            const p = primary.get(d.id);
            const rs = byDevice.get(d.id) ?? [];
            const inRange = rs.filter(
              (r) => (p?.min == null || r.value >= p.min) && (p?.max == null || r.value <= p.max),
            ).length;
            // Only show a compliance % when the primary metric has bounds set.
            const hasBounds = p != null && (p.min != null || p.max != null);
            const pct = hasBounds && rs.length > 0 ? Math.round((inRange / rs.length) * 100) : null;
            const online = Date.now() - new Date(d.last_seen).getTime() < ONLINE_WINDOW_MS;
            const path = sparklinePath(rs.map((r) => r.value), 80, 24);

            return (
              <SidebarLink
                key={d.id}
                id={d.id}
                name={d.name ?? d.mac}
                online={online}
                pct={pct}
                sparkPath={path}
              />
            );
          })
        )}
      </nav>
    </aside>
  );
}
