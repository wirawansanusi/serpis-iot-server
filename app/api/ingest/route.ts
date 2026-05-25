import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { supabase } from "@/lib/supabase";
import type { ChartType } from "@/lib/metrics";

export const dynamic = "force-dynamic";

const KEY_RE = /^[a-z0-9_]{1,32}$/;
const CHART_TYPES: ChartType[] = ["line", "area", "gauge", "bar", "state"];
const BLE_WINDOW_SECONDS = 300;

type IngestMetric = {
  key: string;
  value: number;
  unit?: string;
  label?: string;
  chart_type?: ChartType;
};

function tokenOk(provided: string | null): boolean {
  const expected = process.env.INGEST_TOKEN;
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

// Accept the rich array form or the compact object form. Returns the normalized
// array, or an error string.
function normalizeMetrics(raw: unknown): IngestMetric[] | string {
  let entries: unknown[];
  if (Array.isArray(raw)) {
    entries = raw;
  } else if (raw && typeof raw === "object") {
    entries = Object.entries(raw as Record<string, unknown>).map(([key, value]) => ({ key, value }));
  } else {
    return "metrics must be an array or object";
  }

  const out: IngestMetric[] = [];
  for (const e of entries) {
    if (!e || typeof e !== "object") return "each metric must be an object";
    const m = e as Record<string, unknown>;
    const key = typeof m.key === "string" ? m.key.toLowerCase() : "";
    if (!KEY_RE.test(key)) return `invalid metric key: ${String(m.key)}`;
    if (!isFiniteNumber(m.value)) return `metric ${key}: value must be a number`;

    const metric: IngestMetric = { key, value: m.value };
    if (typeof m.unit === "string") metric.unit = m.unit.slice(0, 16);
    if (typeof m.label === "string") metric.label = m.label.slice(0, 48);
    if (typeof m.chart_type === "string" && CHART_TYPES.includes(m.chart_type as ChartType)) {
      metric.chart_type = m.chart_type as ChartType;
    }
    out.push(metric);
  }
  return out;
}

// Translate claim_state into the device-facing control response.
function controlResponse(state: string) {
  const claimed = state === "claimed";
  const claimable = state === "unclaimed" || state === "claim_pending";
  return {
    ok: true,
    device_state: state,
    claim_required: claimable,
    ble_window_seconds: claimable ? BLE_WINDOW_SECONDS : 0,
    upload_mode: claimed ? "readings" : "heartbeat",
  };
}

export async function POST(req: NextRequest) {
  if (!tokenOk(req.headers.get("x-device-token"))) {
    return NextResponse.json({ error: "invalid token" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "missing body" }, { status: 400 });
  }

  const { public_device_id, mac, device_type, firmware_version, uptime_ms, metrics,
    battery_mv, battery_percent, power_source } = body as Record<string, unknown>;

  if (typeof public_device_id !== "string" || public_device_id.length === 0 || public_device_id.length > 64) {
    return NextResponse.json({ error: "invalid public_device_id" }, { status: 400 });
  }
  for (const [name, v] of [["mac", mac], ["device_type", device_type], ["firmware_version", firmware_version]] as const) {
    if (v !== undefined && typeof v !== "string") {
      return NextResponse.json({ error: `${name} must be a string` }, { status: 400 });
    }
  }
  if (uptime_ms !== undefined && !isFiniteNumber(uptime_ms)) {
    return NextResponse.json({ error: "uptime_ms must be a number if present" }, { status: 400 });
  }

  // Battery status (device status, not charted): top-level fields from firmware.
  const batteryMv = isFiniteNumber(battery_mv) ? Math.round(battery_mv) : null;
  const batteryPct = isFiniteNumber(battery_percent)
    ? Math.max(0, Math.min(100, Math.round(battery_percent)))
    : null;
  const powerSrc = power_source === "external" || power_source === "battery" ? power_source : null;

  // Always touch the device (heartbeat) and learn its claim state.
  const { data: state, error: touchErr } = await supabase.rpc("device_touch", {
    p_public_id: public_device_id,
    p_mac: typeof mac === "string" ? mac.slice(0, 32) : null,
    p_device_type: typeof device_type === "string" ? device_type.slice(0, 64) : null,
    p_firmware: typeof firmware_version === "string" ? firmware_version.slice(0, 32) : null,
    p_battery_mv: batteryMv,
    p_battery_percent: batteryPct,
    p_power_source: powerSrc,
  });
  if (touchErr) {
    console.error("[ingest] device_touch error", touchErr);
    return NextResponse.json({ error: touchErr.message }, { status: 500 });
  }

  const claimState = typeof state === "string" ? state : "unclaimed";

  // Store readings only once claimed (heartbeat-only until then).
  if (claimState === "claimed" && metrics !== undefined) {
    const normalized = normalizeMetrics(metrics);
    if (typeof normalized === "string") {
      return NextResponse.json({ error: normalized }, { status: 400 });
    }
    if (normalized.length > 0) {
      const { error } = await supabase.rpc("ingest_reading", {
        p_public_id: public_device_id,
        p_device_type: typeof device_type === "string" ? device_type.slice(0, 64) : null,
        p_metrics: normalized,
      });
      if (error) {
        console.error("[ingest] ingest_reading error", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
    }
  }

  return NextResponse.json(controlResponse(claimState));
}
