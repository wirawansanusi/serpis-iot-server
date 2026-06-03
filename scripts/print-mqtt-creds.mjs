// Print a device's per-device MQTT credentials, so you can connect to EMQX *as
// that device* (mosquitto_sub/pub, MQTTX) when testing the auth hooks.
//
//   node --env-file=.env scripts/print-mqtt-creds.mjs <public_device_id>
//
// Requires env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CLAIM_SECRET_ENC_KEY.
// The derivation is byte-identical to lib/mqtt-auth.ts (backend) and
// src/main.cpp::deriveMqttCreds (firmware):
//   username = public_device_id
//   password = hex(HMAC_SHA256(claim_secret, "mqtt-auth:" + public_device_id))
import { createClient } from "@supabase/supabase-js";
import { createDecipheriv, createHmac } from "crypto";

const pubid = process.argv[2];
if (!pubid) {
  console.error("usage: node --env-file=.env scripts/print-mqtt-creds.mjs <public_device_id>");
  process.exit(1);
}

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CLAIM_SECRET_ENC_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !CLAIM_SECRET_ENC_KEY) {
  console.error("missing env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CLAIM_SECRET_ENC_KEY");
  process.exit(1);
}

// Mirror of lib/claim-crypto.ts decryptSecret: base64( iv(12) || tag(16) || ct ).
function decryptSecret(enc) {
  const key = Buffer.from(CLAIM_SECRET_ENC_KEY, "base64");
  if (key.length !== 32) throw new Error("CLAIM_SECRET_ENC_KEY must be 32 bytes (base64)");
  const raw = Buffer.from(enc, "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const { data, error } = await supabase
  .from("devices")
  .select("public_device_id, claim_secret_enc, claim_state, device_type")
  .eq("public_device_id", pubid)
  .maybeSingle();
if (error) {
  console.error("query failed:", error.message);
  process.exit(1);
}
if (!data) {
  console.error("device not found:", pubid);
  process.exit(1);
}
if (!data.claim_secret_enc) {
  console.error("device has no claim_secret_enc (not provisioned?)");
  process.exit(1);
}

const secret = decryptSecret(data.claim_secret_enc);
const password = createHmac("sha256", secret).update(`mqtt-auth:${pubid}`, "utf8").digest("hex");

console.log(`device_type : ${data.device_type ?? "(none)"}`);
console.log(`claim_state : ${data.claim_state}`);
console.log(`username    : ${data.public_device_id}`);
console.log(`password    : ${password}`);
console.log("");
console.log("allowed topics:");
console.log(`  subscribe  serpis/ir/${pubid}/cmd`);
console.log(`  publish    serpis/ir/${pubid}/evt`);
console.log(`  publish    serpis/ir/${pubid}/status`);
