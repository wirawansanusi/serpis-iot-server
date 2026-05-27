import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { supabase } from "@/lib/supabase";
import type { ChartType } from "@/lib/metrics";
import { persistOtaStatus, computeIngestOffer, type OtaStatusReport } from "@/lib/ota";

export const dynamic = "force-dynamic";

const KEY_RE = /^[a-z0-9_]{1,32}$/;
const CHART_TYPES: ChartType[] = ["line", "area", "gauge", "bar", "state"];
const BLE_WINDOW_SECONDS = 300;
const MAX_SAMPLE_AGE_MS = 24 * 60 * 60 * 1000;

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
    sample_age_ms, sample_seq, ota_status,
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
  if (sample_seq !== undefined && !isFiniteNumber(sample_seq)) {
    return NextResponse.json({ error: "sample_seq must be a number if present" }, { status: 400 });
  }
  if (sample_age_ms !== undefined && !isFiniteNumber(sample_age_ms)) {
    return NextResponse.json({ error: "sample_age_ms must be a number if present" }, { status: 400 });
  }
  const sampleAgeMs = isFiniteNumber(sample_age_ms)
    ? Math.max(0, Math.min(MAX_SAMPLE_AGE_MS, Math.round(sample_age_ms)))
    : 0;
  const recordedAt = new Date(Date.now() - sampleAgeMs).toISOString();

  // Battery status (device status, not charted): top-level fields from firmware.
  const batteryMv = isFiniteNumber(battery_mv) ? Math.round(battery_mv) : null;
  const batteryPct = isFiniteNumber(battery_percent)
    ? Math.max(0, Math.min(100, Math.round(battery_percent)))
    : null;
  const powerSrc = power_source === "external" || power_source === "battery" ? power_source : null;

  // Optional firmware-reported OTA status. Sanitized to known fields; unknown
  // status strings are kept for forward compatibility.
  let otaStatusReport: OtaStatusReport | null = null;
  if (ota_status && typeof ota_status === "object") {
    const s = ota_status as Record<string, unknown>;
    if (typeof s.status === "string") {
      otaStatusReport = {
        status: s.status.slice(0, 32),
        target_version: typeof s.target_version === "string" ? s.target_version.slice(0, 32) : undefined,
        running_version: typeof s.running_version === "string" ? s.running_version.slice(0, 32) : undefined,
        error_code: isFiniteNumber(s.error_code) ? Math.round(s.error_code) : undefined,
        message: typeof s.message === "string" ? s.message.slice(0, 500) : undefined,
      };
    }
  }

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

  let otaOffer = null;

  // Readings + OTA only once claimed (heartbeat-only until then).
  if (claimState === "claimed") {
    if (metrics !== undefined) {
      const normalized = normalizeMetrics(metrics);
      if (typeof normalized === "string") {
        return NextResponse.json({ error: normalized }, { status: 400 });
      }
      if (normalized.length > 0) {
        const { error } = await supabase.rpc("ingest_reading", {
          p_public_id: public_device_id,
          p_device_type: typeof device_type === "string" ? device_type.slice(0, 64) : null,
          p_metrics: normalized,
          p_recorded_at: recordedAt,
        });
        if (error) {
          console.error("[ingest] ingest_reading error", error);
          return NextResponse.json({ error: error.message }, { status: 500 });
        }
      }
    }

    // Look up the device row (device_touch only returns claim_state) to record
    // OTA status and decide whether to offer an update.
    const { data: device } = await supabase
      .from("devices")
      .select("id, device_type, firmware_version, battery_percent, power_source")
      .eq("public_device_id", public_device_id)
      .maybeSingle();
    if (device) {
      // Persist any reported status BEFORE computing the offer, so a fresh
      // failure blocks re-offering the same version in this same response.
      if (otaStatusReport) await persistOtaStatus(device.id, otaStatusReport);
      const baseUrl = process.env.OTA_BASE_URL ?? new URL(req.url).origin;
      otaOffer = await computeIngestOffer(device, baseUrl);
    }
  }

  const response = controlResponse(claimState);
  return NextResponse.json(otaOffer ? { ...response, ota: otaOffer } : response);
}
