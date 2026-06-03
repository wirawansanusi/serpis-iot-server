import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { supabase } from "@/lib/supabase";
import { validateAutomationInput } from "@/lib/automations";

export const dynamic = "force-dynamic";

const SELECT =
  "id, name, enabled, trigger_device_id, metric_key, operator, threshold, clear_threshold, action_device_id, action, cooldown_minutes, active_hours, is_active, last_fired_at, created_at";

async function ownAutomation(id: string, userId: string) {
  const { data } = await supabase
    .from("automations")
    .select("id")
    .eq("id", id)
    .eq("owner_user_id", userId)
    .maybeSingle();
  return !!data;
}

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

// Update an automation. A body containing `action` is a full edit (re-validated,
// re-checks device ownership, resets the latch); otherwise it's a light patch of
// enabled/name (used by the list's toggle).
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const { userId } = auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (!(await ownAutomation(params.id, userId)))
    return NextResponse.json({ error: "automation not found" }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  let patch: Record<string, unknown>;
  if ("action" in body) {
    const v = validateAutomationInput(body);
    if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
    if (!(await ownsDevice(v.value.trigger_device_id, userId, false)))
      return NextResponse.json({ error: "trigger device not found" }, { status: 404 });
    if (!(await ownsDevice(v.value.action_device_id, userId, true)))
      return NextResponse.json({ error: "action device must be your IR blaster" }, { status: 400 });
    // The rule changed — clear the latch so it can fire fresh on the next breach.
    patch = { ...v.value, is_active: false, updated_at: new Date().toISOString() };
  } else {
    patch = { updated_at: new Date().toISOString() };
    if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
    if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim().slice(0, 64);
    if (Object.keys(patch).length === 1) {
      return NextResponse.json({ error: "nothing to update" }, { status: 400 });
    }
  }

  const { data, error } = await supabase
    .from("automations")
    .update(patch)
    .eq("id", params.id)
    .eq("owner_user_id", userId)
    .select(SELECT)
    .single();
  if (error) {
    console.error("[automations PATCH]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ automation: data });
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const { userId } = auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("automations")
    .delete()
    .eq("id", params.id)
    .eq("owner_user_id", userId)
    .select("id")
    .maybeSingle();
  if (error) {
    console.error("[automations DELETE]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) return NextResponse.json({ error: "automation not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
