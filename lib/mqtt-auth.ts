// Per-device MQTT authentication + authorization, called by EMQX's HTTP authn/
// authz hooks (see deploy/emqx). Each IR blaster connects with:
//   username = public_device_id
//   password = lowercase hex of HMAC_SHA256(claim_secret, "mqtt-auth:"+pubid)
// which both sides derive from the per-device claim secret already provisioned
// (firmware: mbedTLS in main.cpp; here: from claim_secret_enc). The backend's own
// mqtt.js client connects as a superuser via MQTT_USERNAME/MQTT_PASSWORD.
//
// The hook routes are not Clerk-authed (EMQX calls them machine-to-machine); they
// are guarded by a shared secret header (MQTT_AUTH_HOOK_SECRET) and only reachable
// inside the Docker network.
import { createHmac, timingSafeEqual } from "crypto";
import { supabase } from "@/lib/supabase";
import { decryptSecret } from "@/lib/claim-crypto";

const TOPIC_PREFIX = "serpis/ir";

// Derive the device's MQTT password from its claim secret. Byte-identical to the
// firmware's mbedtls_md_hmac over the same message.
export function deriveMqttPassword(claimSecret: Buffer, publicDeviceId: string): string {
  return createHmac("sha256", claimSecret).update(`mqtt-auth:${publicDeviceId}`, "utf8").digest("hex");
}

function hexEq(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length || a.length === 0) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

function strEq(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export type AuthResult = { allow: boolean; superuser: boolean };

// Validate a CONNECT. Recognizes the backend superuser (env creds) and any
// provisioned, non-disabled device whose derived password matches.
export async function authenticateMqtt(username: string, password: string): Promise<AuthResult> {
  if (!username || !password) return { allow: false, superuser: false };

  // Backend service account (the serpis-iot-server mqtt.js client). Full access.
  if (strEq(username, process.env.MQTT_USERNAME) && strEq(password, process.env.MQTT_PASSWORD)) {
    return { allow: true, superuser: true };
  }

  // Device: username is its public_device_id.
  const { data: device } = await supabase
    .from("devices")
    .select("public_device_id, claim_secret_enc, claim_state")
    .eq("public_device_id", username)
    .maybeSingle();
  if (!device || !device.claim_secret_enc || device.claim_state === "disabled") {
    return { allow: false, superuser: false };
  }

  let expected: string;
  try {
    expected = deriveMqttPassword(decryptSecret(device.claim_secret_enc), device.public_device_id);
  } catch (e) {
    console.error("[mqtt-auth] derive failed", e);
    return { allow: false, superuser: false };
  }
  return { allow: hexEq(expected, password), superuser: false };
}

// A device may only touch its own topics: subscribe its cmd, publish evt/status.
// (The backend superuser bypasses ACL entirely via is_superuser at authn.)
export function authorizeMqtt(username: string, topic: string, action: "publish" | "subscribe"): boolean {
  if (!username || !topic) return false;
  const base = `${TOPIC_PREFIX}/${username}/`;
  if (!topic.startsWith(base)) return false;
  const leaf = topic.slice(base.length);
  if (action === "subscribe") return leaf === "cmd";
  return leaf === "evt" || leaf === "status"; // publish
}

// Constant-time check of the shared secret EMQX sends on every hook request.
export function hookSecretOk(provided: string | null): boolean {
  const expected = process.env.MQTT_AUTH_HOOK_SECRET;
  if (!expected) {
    console.warn("[mqtt-auth] MQTT_AUTH_HOOK_SECRET not set; rejecting hook calls");
    return false;
  }
  return strEq(provided ?? undefined, expected);
}
