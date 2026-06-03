import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { randomUUID } from "crypto";
import { supabase } from "@/lib/supabase";
import { publishCommand, ensureMqtt } from "@/lib/mqtt";

export const dynamic = "force-dynamic";

// Bring up the MQTT singleton (+ evt subscriber) when this route loads, so the
// {kind:"learned"} reply is captured even before any command publish.
ensureMqtt();

const MIN_TIMEOUT = 5;
const MAX_TIMEOUT = 60;
const DEFAULT_TIMEOUT = 30;

async function ownIrBlaster(deviceId: string, userId: string) {
  const { data } = await supabase
    .from("devices")
    .select("id, public_device_id, device_type")
    .eq("id", deviceId)
    .eq("owner_user_id", userId)
    .maybeSingle();
  return data;
}

// Start DIY learn: enqueue a {kind:"learn"} command and publish it so the device
// arms IRrecv. Returns the command id; poll GET .../learn?id=<id> for the result.
// Body (optional): { timeout_s }.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { userId } = auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let timeout_s = DEFAULT_TIMEOUT;
  try {
    const body = (await req.json()) as { timeout_s?: unknown };
    if (typeof body?.timeout_s === "number" && Number.isFinite(body.timeout_s)) {
      timeout_s = Math.min(MAX_TIMEOUT, Math.max(MIN_TIMEOUT, Math.round(body.timeout_s)));
    }
  } catch {
    // empty/invalid body — use the default timeout
  }

  const device = await ownIrBlaster(params.id, userId);
  if (!device) return NextResponse.json({ error: "device not found" }, { status: 404 });
  if (device.device_type !== "ir-blaster-esp32c3") {
    return NextResponse.json({ error: "device is not an IR blaster" }, { status: 400 });
  }

  const id = randomUUID();
  const command = { id, kind: "learn", timeout_s };

  const { error: insErr } = await supabase.from("device_commands").insert({
    id,
    device_id: device.id,
    command,
    created_by: userId,
    status: "queued",
  });
  if (insErr) {
    console.error("[learn] insert", insErr);
    return NextResponse.json({ error: insErr.message }, { status: 500 });
  }

  const sent = await publishCommand(device.public_device_id, command);
  if (sent) {
    await supabase
      .from("device_commands")
      .update({ status: "sent", sent_at: new Date().toISOString() })
      .eq("id", id);
  }

  return NextResponse.json({ id, status: sent ? "sent" : "queued", timeout_s }, { status: 201 });
}

// Poll a learn request: GET .../learn?id=<commandId>. Returns the row's status
// and, once the device replies, the captured command in `result`.
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const { userId } = auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const commandId = req.nextUrl.searchParams.get("id");
  if (!commandId) return NextResponse.json({ error: "missing ?id=" }, { status: 400 });

  const device = await ownIrBlaster(params.id, userId);
  if (!device) return NextResponse.json({ error: "device not found" }, { status: 404 });

  const { data, error } = await supabase
    .from("device_commands")
    .select("id, status, ack_ok, ack_error, result, created_at, acked_at")
    .eq("id", commandId)
    .eq("device_id", device.id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "learn request not found" }, { status: 404 });

  return NextResponse.json({
    id: data.id,
    status: data.status,
    ok: data.ack_ok,
    error: data.ack_error,
    result: data.result ?? null,
    acked_at: data.acked_at,
  });
}
