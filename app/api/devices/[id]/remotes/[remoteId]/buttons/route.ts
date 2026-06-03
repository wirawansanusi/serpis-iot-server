import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { supabase } from "@/lib/supabase";
import { validateCommand } from "@/lib/ir";

export const dynamic = "force-dynamic";

// Add a button to a device remote. Used to save a DIY-learned code (kind
// protocol|raw) under a user-chosen label, but works for any valid command.
// Owner-scoped: the remote must belong to the caller and to this device.
//
// Body: { label, command }.
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; remoteId: string } },
) {
  const { userId } = auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { label?: unknown; command?: unknown };
  try {
    body = (await req.json()) as { label?: unknown; command?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const label = typeof body.label === "string" ? body.label.trim().slice(0, 48) : "";
  if (!label) return NextResponse.json({ error: "label is required" }, { status: 400 });

  const result = validateCommand(body.command);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

  // Verify the remote belongs to this device AND this owner.
  const { data: remote } = await supabase
    .from("device_remotes")
    .select("id")
    .eq("id", params.remoteId)
    .eq("device_id", params.id)
    .eq("owner_user_id", userId)
    .maybeSingle();
  if (!remote) return NextResponse.json({ error: "remote not found" }, { status: 404 });

  // Append after the current max sort_order so it lands at the end of the grid.
  const { data: last } = await supabase
    .from("device_remote_buttons")
    .select("sort_order")
    .eq("remote_id", params.remoteId)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  const sortOrder = (last?.sort_order ?? 0) + 10;

  const { data: button, error } = await supabase
    .from("device_remote_buttons")
    .insert({ remote_id: params.remoteId, label, command: result.command, sort_order: sortOrder })
    .select("id, label, command")
    .single();
  if (error) {
    console.error("[remote buttons POST]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ button }, { status: 201 });
}
