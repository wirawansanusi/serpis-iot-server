import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { supabase } from "@/lib/supabase";
import { CADENCES, type Cadence } from "@/lib/notifications";

export const dynamic = "force-dynamic";

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

// Set a device's notification preferences. Owner-scoped. The alert band lives
// here (independent of the humidity profile, per the chosen design); the app
// sends a profile snapshot when use_profile is true.
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

  if (typeof b.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
  }
  const cadence = b.cadence;
  if (typeof cadence !== "string" || !CADENCES.includes(cadence as Cadence)) {
    return NextResponse.json({ error: `cadence must be one of ${CADENCES.join(", ")}` }, { status: 400 });
  }
  const useProfile = b.use_profile !== false; // default true
  const alertLow = isFiniteNumber(b.alert_low) ? Math.max(0, Math.min(100, b.alert_low)) : null;
  const alertHigh = isFiniteNumber(b.alert_high) ? Math.max(0, Math.min(100, b.alert_high)) : null;
  if (b.enabled && alertLow === null && alertHigh === null) {
    return NextResponse.json({ error: "need at least one of alert_low / alert_high when enabled" }, { status: 400 });
  }
  if (alertLow !== null && alertHigh !== null && alertLow >= alertHigh) {
    return NextResponse.json({ error: "alert_low must be below alert_high" }, { status: 400 });
  }
  const tzOffset = isFiniteNumber(b.tz_offset_minutes)
    ? Math.max(-840, Math.min(840, Math.round(b.tz_offset_minutes)))
    : 0;

  // Verify ownership before writing settings.
  const { data: device } = await supabase
    .from("devices")
    .select("id")
    .eq("id", params.id)
    .eq("owner_user_id", userId)
    .maybeSingle();
  if (!device) return NextResponse.json({ error: "device not found" }, { status: 404 });

  const { data, error } = await supabase
    .from("device_notification_settings")
    .upsert(
      {
        device_id: params.id,
        enabled: b.enabled,
        use_profile: useProfile,
        alert_low: alertLow,
        alert_high: alertHigh,
        cadence,
        tz_offset_minutes: tzOffset,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "device_id" },
    )
    .select("enabled, use_profile, alert_low, alert_high, cadence, tz_offset_minutes")
    .maybeSingle();
  if (error) {
    console.error("[notifications settings]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json(data);
}
