import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

type ButtonRow = { id: string; label: string; command: unknown; sort_order: number };

async function ownDevice(deviceId: string, userId: string) {
  const { data } = await supabase
    .from("devices")
    .select("id, device_type")
    .eq("id", deviceId)
    .eq("owner_user_id", userId)
    .maybeSingle();
  return data;
}

// List the remotes attached to a device (each with its buttons). The app renders
// a climate panel for kind=ac remotes and a button grid for the rest.
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const { userId } = auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const device = await ownDevice(params.id, userId);
  if (!device) return NextResponse.json({ error: "device not found" }, { status: 404 });

  const { data, error } = await supabase
    .from("device_remotes")
    .select("id, name, kind, ac_vendor, model_id, buttons:device_remote_buttons(id, label, command, sort_order)")
    .eq("device_id", params.id)
    .order("created_at", { ascending: true });
  if (error) {
    console.error("[remotes GET]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const remotes = (data ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    ac_vendor: r.ac_vendor,
    model_id: r.model_id,
    buttons: ((r.buttons as ButtonRow[]) ?? [])
      .slice()
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((b) => ({ id: b.id, label: b.label, command: b.command })),
  }));
  return NextResponse.json({ remotes });
}

// Add a remote to a device. Either:
//   { model_id }                              -> materialize from the catalog
//   { name, kind?, ac_vendor? }               -> create a custom/empty remote
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { userId } = auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const device = await ownDevice(params.id, userId);
  if (!device) return NextResponse.json({ error: "device not found" }, { status: 404 });
  if (device.device_type !== "ir-blaster-esp32c3") {
    return NextResponse.json({ error: "device is not an IR blaster" }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  let name: string;
  let kind = "other";
  let acVendor: string | null = null;
  let modelId: string | null = null;
  let functions: { name: string; command: unknown; sort_order: number }[] = [];

  if (typeof body.model_id === "string") {
    const { data: model, error: mErr } = await supabase
      .from("ir_models")
      .select("id, name, device_kind, ac_vendor, brand:ir_brands(name), ir_functions(name, command, sort_order)")
      .eq("id", body.model_id)
      .maybeSingle();
    if (mErr) return NextResponse.json({ error: mErr.message }, { status: 500 });
    if (!model) return NextResponse.json({ error: "model not found" }, { status: 404 });

    const brandRel = model.brand as unknown as { name: string } | { name: string }[] | null;
    const brandName = Array.isArray(brandRel) ? brandRel[0]?.name : brandRel?.name;
    name = [brandName, model.name].filter(Boolean).join(" ") || model.name;
    kind = model.device_kind;
    acVendor = model.ac_vendor;
    modelId = model.id;
    functions = (model.ir_functions as { name: string; command: unknown; sort_order: number }[]) ?? [];
  } else if (typeof body.name === "string" && body.name.trim().length > 0) {
    name = body.name.trim().slice(0, 64);
    if (typeof body.kind === "string") kind = body.kind;
    if (typeof body.ac_vendor === "string") acVendor = body.ac_vendor;
  } else {
    return NextResponse.json({ error: "provide model_id or name" }, { status: 400 });
  }

  const { data: remote, error: rErr } = await supabase
    .from("device_remotes")
    .insert({
      device_id: params.id,
      owner_user_id: userId,
      name,
      kind,
      ac_vendor: acVendor,
      model_id: modelId,
    })
    .select("id, name, kind, ac_vendor, model_id")
    .single();
  if (rErr) {
    console.error("[remotes POST]", rErr);
    return NextResponse.json({ error: rErr.message }, { status: 500 });
  }

  let buttons: { id: string; label: string; command: unknown }[] = [];
  if (functions.length > 0) {
    const rows = functions.map((f) => ({
      remote_id: remote.id,
      label: f.name,
      command: f.command,
      sort_order: f.sort_order ?? 100,
    }));
    const { data: btns, error: bErr } = await supabase
      .from("device_remote_buttons")
      .insert(rows)
      .select("id, label, command, sort_order");
    if (bErr) {
      console.error("[remotes POST buttons]", bErr);
      return NextResponse.json({ error: bErr.message }, { status: 500 });
    }
    buttons = ((btns as ButtonRow[]) ?? [])
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((b) => ({ id: b.id, label: b.label, command: b.command }));
  }

  return NextResponse.json({ remote: { ...remote, buttons } }, { status: 201 });
}
