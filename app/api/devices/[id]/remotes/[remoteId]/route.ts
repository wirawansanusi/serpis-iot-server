import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// Remove a remote (and its buttons, via cascade) from a device. Owner-scoped.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string; remoteId: string } },
) {
  const { userId } = auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("device_remotes")
    .delete()
    .eq("id", params.remoteId)
    .eq("device_id", params.id)
    .eq("owner_user_id", userId)
    .select("id")
    .maybeSingle();
  if (error) {
    console.error("[remotes DELETE]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) return NextResponse.json({ error: "remote not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
