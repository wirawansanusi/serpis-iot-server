import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { supabase } from "@/lib/supabase";
import { ensureMqtt } from "@/lib/mqtt";
import { validateAutomationInput } from "@/lib/automations";

export const dynamic = "force-dynamic";

// Keep the MQTT singleton warm so a fired automation can publish promptly.
ensureMqtt();

const SELECT =
  "id, name, enabled, trigger_device_id, metric_key, operator, threshold, clear_threshold, action_device_id, action, cooldown_minutes, active_hours, is_active, last_fired_at, created_at";

// Attach trigger/action device display names (one extra query, mapped in memory).
async function withDeviceNames(rows: Record<string, unknown>[]) {
  const ids = new Set<string>();
  for (const r of rows) {
    if (typeof r.trigger_device_id === "string") ids.add(r.trigger_device_id);
    if (typeof r.action_device_id === "string") ids.add(r.action_device_id);
  }
  if (ids.size === 0) return rows;
  const { data } = await supabase.from("devices").select("id, name").in("id", [...ids]);
  const nameById = new Map((data ?? []).map((d) => [d.id, d.name as string | null]));
  return rows.map((r) => ({
    ...r,
    trigger_device_name: nameById.get(r.trigger_device_id as string) ?? null,
    action_device_name: nameById.get(r.action_device_id as string) ?? null,
  }));
}

// Verify the caller owns the device, optionally requiring it to be an IR blaster.
async function ownsDevice(deviceId: string, userId: string, requireIrBlaster: boolean) {
  const { data } = await supabase
    .from("devices")
    .select("id, device_type")
    .eq("id", deviceId)
    .eq("owner_user_id", userId)
    .maybeSingle();
  if (!data) return false;
  if (requireIrBlaster && data.device_type !== "ir-blaster-esp32c3") return false;
  return true;
}

// List the signed-in user's automations (newest first).
export async function GET() {
  const { userId } = auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("automations")
    .select(SELECT)
    .eq("owner_user_id", userId)
    .order("created_at", { ascending: false });
  if (error) {
    console.error("[automations GET]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ automations: await withDeviceNames(data ?? []) });
}

// Create an automation. Both the trigger and action devices must be owned by the
// caller, and the action device must be an IR blaster.
export async function POST(req: NextRequest) {
  const { userId } = auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const v = validateAutomationInput(body);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });

  if (!(await ownsDevice(v.value.trigger_device_id, userId, false)))
    return NextResponse.json({ error: "trigger device not found" }, { status: 404 });
  if (!(await ownsDevice(v.value.action_device_id, userId, true)))
    return NextResponse.json({ error: "action device must be your IR blaster" }, { status: 400 });

  const { data, error } = await supabase
    .from("automations")
    .insert({ owner_user_id: userId, ...v.value })
    .select(SELECT)
    .single();
  if (error) {
    console.error("[automations POST]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const [withNames] = await withDeviceNames([data]);
  return NextResponse.json({ automation: withNames }, { status: 201 });
}
