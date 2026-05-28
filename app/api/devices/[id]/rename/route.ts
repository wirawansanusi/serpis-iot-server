import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// Rename a device. Owner-scoped (the same Clerk userId that claimed it). An
// empty/whitespace name resets to null so the UI falls back to MAC.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { userId } = auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "missing body" }, { status: 400 });
  }
  const raw = typeof (body as Record<string, unknown>).name === "string"
    ? ((body as Record<string, string>).name).trim()
    : "";
  const name = raw.length > 0 ? raw.slice(0, 64) : null;

  const { data, error } = await supabase
    .from("devices")
    .update({ name })
    .eq("id", params.id)
    .eq("owner_user_id", userId)
    .select("id, name")
    .maybeSingle();
  if (error) {
    console.error("[rename device]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) return NextResponse.json({ error: "device not found" }, { status: 404 });
  return NextResponse.json({ id: data.id, name: data.name });
}
