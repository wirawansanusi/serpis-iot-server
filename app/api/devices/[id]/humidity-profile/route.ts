import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { supabase } from "@/lib/supabase";
import { HUMIDITY_KEY } from "@/lib/notifications";

export const dynamic = "force-dynamic";

// Named humidity presets. MUST match the app's HUMIDITY_PROFILES ids in
// serpis-iot-hub-app/lib/humidity.ts. "custom" is a user-typed band (no preset).
const ALLOWED_PROFILE_IDS = ["electronics", "comfort", "instruments", "wine", "custom"];

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

// Set a sensor's humidity profile — the named preset plus its low/high band.
// Server-owned and per-sensor (not per-phone), so every phone shows the same
// thing. The band lives in device_metric_thresholds, the SAME row the ingest
// events engine reads, so changing the profile also moves event detection. And
// when this device's alerts are in "use profile" mode, the push alert band is
// brought along in the same call — keeping all three (coloring, events, alerts)
// in lockstep. Owner-scoped.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { userId } = auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const profileId = b.profile_id;
  if (typeof profileId !== "string" || !ALLOWED_PROFILE_IDS.includes(profileId)) {
    return NextResponse.json({ error: `profile_id must be one of ${ALLOWED_PROFILE_IDS.join(", ")}` }, { status: 400 });
  }
  const low = b.low;
  const high = b.high;
  if (!isFiniteNumber(low) || !isFiniteNumber(high) || low < 0 || high > 100 || low >= high) {
    return NextResponse.json({ error: "need numbers with 0 <= low < high <= 100" }, { status: 400 });
  }

  // device_metric_thresholds has no owner column, so verify ownership via devices.
  const { data: device } = await supabase
    .from("devices")
    .select("id")
    .eq("id", params.id)
    .eq("owner_user_id", userId)
    .maybeSingle();
  if (!device) return NextResponse.json({ error: "device not found" }, { status: 404 });

  // Upsert: the humidity row may already exist (ingest auto-registers it on first
  // reading) or not yet (app changed the profile before the first check-in). The
  // user's pick wins over ingest's `on conflict do nothing` defaults either way.
  const { data, error } = await supabase
    .from("device_metric_thresholds")
    .upsert(
      { device_id: params.id, metric_key: HUMIDITY_KEY, min_val: low, max_val: high, profile_id: profileId },
      { onConflict: "device_id,metric_key" },
    )
    .select("metric_key, min_val, max_val, profile_id")
    .maybeSingle();
  if (error) {
    console.error("[humidity-profile]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Keep the push alert band following the profile when alerts use it. No row, or
  // use_profile off (custom band), means leave alerting alone.
  const { data: notif } = await supabase
    .from("device_notification_settings")
    .select("use_profile")
    .eq("device_id", params.id)
    .maybeSingle();
  if (notif?.use_profile) {
    await supabase
      .from("device_notification_settings")
      .update({ alert_low: low, alert_high: high, updated_at: new Date().toISOString() })
      .eq("device_id", params.id);
  }

  return NextResponse.json(data);
}
