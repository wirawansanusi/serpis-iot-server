import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// "Remove" a device from this user's account. Doesn't delete the device row or
// any readings — just clears ownership and resets claim_state to 'unclaimed'
// so the sensor can be re-claimed (by the same user, or by someone else after
// physical handover). Readings stay on the server so a future owner of the
// same hardware can decide whether to keep or wipe the history.
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const { userId } = auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("devices")
    .update({ owner_user_id: null, claim_state: "unclaimed" })
    .eq("id", params.id)
    .eq("owner_user_id", userId)
    .select("id")
    .maybeSingle();
  if (error) {
    console.error("[remove device]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) return NextResponse.json({ error: "device not found" }, { status: 404 });
  return NextResponse.json({ id: data.id });
}
