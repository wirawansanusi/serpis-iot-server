import { NextResponse } from "next/server";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// Delete the signed-in user's account (App Store Guideline 5.1.1(v): account
// creation requires in-app deletion). We disown their sensors rather than delete
// them — same as "remove device", so the hardware (and its history) can be
// re-claimed by a future owner — then clear the user's personal config and
// finally delete the Clerk identity.
export async function POST() {
  const { userId } = auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // The user's devices, so we can clear their per-device config (no FK cascade
  // fires since the rows are disowned, not deleted).
  const { data: ownedDevices } = await supabase.from("devices").select("id").eq("owner_user_id", userId);
  const deviceIds = ((ownedDevices ?? []) as { id: string }[]).map((d) => d.id);

  if (deviceIds.length > 0) {
    await supabase.from("device_notification_settings").delete().in("device_id", deviceIds);
    await supabase.from("device_alert_state").delete().in("device_id", deviceIds);
    const { error: disownErr } = await supabase
      .from("devices")
      .update({
        owner_user_id: null,
        claim_state: "unclaimed",
        claimed_at: null,
        name: null,
        // Land the sensor in BLE provisioning for its next owner on next ingest.
        wipe_credentials_pending: true,
      })
      .eq("owner_user_id", userId);
    if (disownErr) {
      console.error("[account delete] disown devices", disownErr);
      return NextResponse.json({ error: "Could not release your devices" }, { status: 500 });
    }
  }

  // Stop sending pushes to this user's installs.
  await supabase.from("push_tokens").delete().eq("user_id", userId);

  // Finally delete the auth identity. This is the irreversible step, done last
  // so a failure above aborts before the account is gone.
  try {
    await clerkClient().users.deleteUser(userId);
  } catch (e) {
    console.error("[account delete] clerk", e);
    return NextResponse.json({ error: "Could not delete account" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
