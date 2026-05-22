import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { SidebarLink } from "./SidebarLink";

const DAY_MS = 24 * 60 * 60 * 1000;
const ONLINE_WINDOW_MS = 15 * 60 * 1000;

type Device = {
  id: string;
  mac: string;
  name: string | null;
  humidity_min: number;
  humidity_max: number;
  last_seen: string;
};

type Reading = {
  device_id: string;
  humidity: number;
  recorded_at: string;
};

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
    .select("id, mac, name, humidity_min, humidity_max, last_seen")
    .eq("owner_user_id", userId)
    .order("last_seen", { ascending: false });
  const devices: Device[] = devicesData ?? [];

  const deviceIds = devices.map((d) => d.id);
  const readings: Reading[] = deviceIds.length === 0
    ? []
    : (await supabase
        .from("readings")
        .select("device_id, humidity, recorded_at")
        .in("device_id", deviceIds)
        .gte("recorded_at", sinceDay)).data ?? [];

  // Group readings per device, sorted by time
  const byDevice = new Map<string, Reading[]>();
  for (const r of readings) {
    const arr = byDevice.get(r.device_id);
    if (arr) arr.push(r);
    else byDevice.set(r.device_id, [r]);
  }
  for (const arr of byDevice.values()) {
    arr.sort((a, b) => (a.recorded_at < b.recorded_at ? -1 : 1));
  }

  return (
    <aside className="sidebar">
      <h2>Devices</h2>
      <Link href="/dashboard/claim" className="add-btn">+ Add device</Link>
      <nav>
        {devices.length === 0 ? (
          <p className="empty">No devices yet.</p>
        ) : (
          devices.map((d) => {
            const rs = byDevice.get(d.id) ?? [];
            const inRange = rs.filter((r) => r.humidity >= d.humidity_min && r.humidity <= d.humidity_max).length;
            const pct = rs.length > 0 ? Math.round((inRange / rs.length) * 100) : null;
            const online = Date.now() - new Date(d.last_seen).getTime() < ONLINE_WINDOW_MS;
            const values = rs.map((r) => r.humidity);
            const path = sparklinePath(values, 80, 24);

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
