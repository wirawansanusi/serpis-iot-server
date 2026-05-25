import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { supabase } from "@/lib/supabase";
import { computeProof, verifyProof, decryptSecret } from "@/lib/claim-crypto";

export const dynamic = "force-dynamic";

// Step 2 of the claim handshake. Verify the device's HMAC proof against the
// stored (encrypted) secret and the issued challenge, then atomically bind
// ownership. Errors use the PRD's error codes.
export async function POST(req: NextRequest) {
  const { userId } = auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const { public_device_id, claim_nonce, server_challenge, claim_proof } =
    (body as Record<string, unknown>) ?? {};
  if (
    typeof public_device_id !== "string" ||
    typeof claim_nonce !== "string" ||
    typeof server_challenge !== "string" ||
    typeof claim_proof !== "string"
  ) {
    return NextResponse.json({ error: "missing claim fields" }, { status: 400 });
  }

  const { data: device } = await supabase
    .from("devices")
    .select("public_device_id, owner_user_id, claim_state, claim_secret_enc")
    .eq("public_device_id", public_device_id)
    .maybeSingle();

  if (!device) return NextResponse.json({ error: "device_not_found" }, { status: 404 });
  if (device.claim_state === "claimed") {
    // Idempotent success if this user already owns it; otherwise reject.
    if (device.owner_user_id === userId) {
      return NextResponse.json({ ok: true, public_device_id, owner_user_id: userId });
    }
    return NextResponse.json({ error: "device_already_claimed" }, { status: 409 });
  }
  if (!device.claim_secret_enc) {
    return NextResponse.json({ error: "device_not_provisioned" }, { status: 409 });
  }

  // The challenge must exist for this (device, user, challenge), be unused, and unexpired.
  const { data: challenge } = await supabase
    .from("device_claim_challenges")
    .select("id, expires_at, used_at")
    .eq("public_device_id", public_device_id)
    .eq("user_id", userId)
    .eq("server_challenge", server_challenge)
    .maybeSingle();

  if (!challenge || challenge.used_at || new Date(challenge.expires_at).getTime() < Date.now()) {
    return NextResponse.json({ error: "claim_challenge_expired" }, { status: 410 });
  }

  let secret: Buffer;
  try {
    secret = decryptSecret(device.claim_secret_enc);
  } catch (e) {
    console.error("[claim/complete] decrypt failed", e);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }

  const expected = computeProof(secret, public_device_id, claim_nonce, server_challenge);
  if (!verifyProof(expected, claim_proof)) {
    return NextResponse.json({ error: "invalid_claim_proof" }, { status: 401 });
  }

  const { data: claimed, error } = await supabase.rpc("claim_device", {
    p_public_id: public_device_id,
    p_user_id: userId,
  });
  if (error) {
    console.error("[claim/complete] claim_device", error);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
  if (!claimed) {
    return NextResponse.json({ error: "device_already_claimed" }, { status: 409 });
  }

  await supabase
    .from("device_claim_challenges")
    .update({ used_at: new Date().toISOString() })
    .eq("id", challenge.id);

  return NextResponse.json({ ok: true, public_device_id, owner_user_id: userId });
}
