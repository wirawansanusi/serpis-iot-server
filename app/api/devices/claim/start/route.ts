import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { supabase } from "@/lib/supabase";
import { randomB64url } from "@/lib/claim-crypto";

export const dynamic = "force-dynamic";

const CHALLENGE_TTL_SECONDS = 300;

// Step 1 of the claim handshake. The signed-in user names a device (discovered
// over BLE); we issue a short-lived server_challenge they relay to the device.
export async function POST(req: NextRequest) {
  const { userId } = auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const publicDeviceId = (body as Record<string, unknown>)?.public_device_id;
  if (typeof publicDeviceId !== "string" || publicDeviceId.length === 0 || publicDeviceId.length > 64) {
    return NextResponse.json({ error: "invalid public_device_id" }, { status: 400 });
  }

  const { data: device } = await supabase
    .from("devices")
    .select("public_device_id, owner_user_id, claim_state, claim_secret_enc")
    .eq("public_device_id", publicDeviceId)
    .maybeSingle();

  if (!device) return NextResponse.json({ error: "device_not_found" }, { status: 404 });
  if (device.claim_state === "claimed" && device.owner_user_id && device.owner_user_id !== userId) {
    return NextResponse.json({ error: "device_already_claimed" }, { status: 409 });
  }
  if (!device.claim_secret_enc) {
    return NextResponse.json({ error: "device_not_provisioned" }, { status: 409 });
  }

  const serverChallenge = randomB64url(32);
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_SECONDS * 1000).toISOString();

  // Replace any prior unused challenge for this (device, user).
  await supabase
    .from("device_claim_challenges")
    .delete()
    .eq("public_device_id", publicDeviceId)
    .eq("user_id", userId)
    .is("used_at", null);

  const { error } = await supabase.from("device_claim_challenges").insert({
    public_device_id: publicDeviceId,
    user_id: userId,
    server_challenge: serverChallenge,
    expires_at: expiresAt,
  });
  if (error) {
    console.error("[claim/start]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (device.claim_state !== "claimed") {
    await supabase
      .from("devices")
      .update({ claim_state: "claim_pending" })
      .eq("public_device_id", publicDeviceId)
      .neq("claim_state", "claimed");
  }

  return NextResponse.json({ server_challenge: serverChallenge, expires_in_seconds: CHALLENGE_TTL_SECONDS });
}
