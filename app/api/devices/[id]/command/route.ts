import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { randomUUID } from "crypto";
import { supabase } from "@/lib/supabase";
import { validateCommand } from "@/lib/ir";
import { publishCommand, ensureMqtt } from "@/lib/mqtt";

export const dynamic = "force-dynamic";

// Bring up the MQTT singleton (+ ack subscriber) when this route module loads.
ensureMqtt();

// Send an IR command to a device. Owner-scoped (the Clerk userId that claimed
// it). The command is recorded in device_commands and published to the device
// over MQTT; the device replies on .../evt which flips the row to acked/failed.
//
// Body: the command object, or { command: <command> }. See lib/ir.ts shapes.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { userId } = auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const rawCommand =
    body && typeof body === "object" && "command" in (body as Record<string, unknown>)
      ? (body as Record<string, unknown>).command
      : body;

  const result = validateCommand(rawCommand);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

  // Verify ownership + that this is actually an IR blaster, and fetch the MQTT
  // topic key (public_device_id).
  const { data: device, error: devErr } = await supabase
    .from("devices")
    .select("id, public_device_id, device_type")
    .eq("id", params.id)
    .eq("owner_user_id", userId)
    .maybeSingle();
  if (devErr) {
    console.error("[command] device lookup", devErr);
    return NextResponse.json({ error: devErr.message }, { status: 500 });
  }
  if (!device) return NextResponse.json({ error: "device not found" }, { status: 404 });
  if (device.device_type !== "ir-blaster-esp32c3") {
    return NextResponse.json({ error: "device is not an IR blaster" }, { status: 400 });
  }

  const id = randomUUID();
  const command = { ...result.command, id };

  const { error: insErr } = await supabase.from("device_commands").insert({
    id,
    device_id: device.id,
    command,
    created_by: userId,
    status: "queued",
  });
  if (insErr) {
    console.error("[command] insert", insErr);
    return NextResponse.json({ error: insErr.message }, { status: 500 });
  }

  const sent = await publishCommand(device.public_device_id, command);
  if (sent) {
    await supabase
      .from("device_commands")
      .update({ status: "sent", sent_at: new Date().toISOString() })
      .eq("id", id);
  }

  return NextResponse.json({ id, status: sent ? "sent" : "queued" }, { status: 201 });
}

// Recent commands for a device (newest first) so the app can show ack status.
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const { userId } = auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data: device } = await supabase
    .from("devices")
    .select("id")
    .eq("id", params.id)
    .eq("owner_user_id", userId)
    .maybeSingle();
  if (!device) return NextResponse.json({ error: "device not found" }, { status: 404 });

  const { data, error } = await supabase
    .from("device_commands")
    .select("id, command, status, created_at, sent_at, acked_at, ack_ok, ack_error")
    .eq("device_id", device.id)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ commands: data ?? [] });
}
