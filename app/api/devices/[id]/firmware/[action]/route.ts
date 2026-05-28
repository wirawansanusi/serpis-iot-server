import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { supabase } from "@/lib/supabase";
import { requestUpdate, retryUpdate } from "@/lib/ota";

export const dynamic = "force-dynamic";

// Mobile firmware actions. Status is read via /api/dashboard (folded in); these
// only mutate per-device OTA intent and return the refreshed firmware summary.
// No dismiss: firmware updates can't be ignored — the notification persists
// until the user actually updates.
const HANDLERS = { update: requestUpdate, retry: retryUpdate } as const;

export async function POST(req: NextRequest, { params }: { params: { id: string; action: string } }) {
  const { userId } = auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const handler = HANDLERS[params.action as keyof typeof HANDLERS];
  if (!handler) return NextResponse.json({ error: "unknown action" }, { status: 404 });

  // Scope to a device this user owns (the :id is the internal device UUID).
  const { data: device } = await supabase
    .from("devices")
    .select("id, device_type, firmware_version, battery_percent, power_source")
    .eq("id", params.id)
    .eq("owner_user_id", userId)
    .maybeSingle();
  if (!device) return NextResponse.json({ error: "device not found" }, { status: 404 });

  const firmware = await handler(device);
  return NextResponse.json({ firmware });
}
