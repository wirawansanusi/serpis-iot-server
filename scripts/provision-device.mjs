#!/usr/bin/env node
// Factory provisioning: mint a device identity, register it in the backend
// (secret encrypted at rest), and emit an NVS image to flash onto the device.
//
//   node --env-file=.env.local scripts/provision-device.mjs [--type humid-sht31]
//
// Requires env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CLAIM_SECRET_ENC_KEY.
// Outputs (under ./provisioning/<public_device_id>/): nvs.csv and a printed
// command to build + flash the NVS partition. The secret is shown ONCE for the
// NVS image and never stored in plaintext server-side.

import { createCipheriv, randomBytes, randomUUID } from "crypto";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { createClient } from "@supabase/supabase-js";

// AES-256-GCM, format base64( iv(12) || tag(16) || ciphertext ) — must match lib/claim-crypto.ts.
function encryptSecret(secret, keyB64) {
  const key = Buffer.from(keyB64, "base64");
  if (key.length !== 32) throw new Error("CLAIM_SECRET_ENC_KEY must be 32 bytes (base64)");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(secret), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CLAIM_SECRET_ENC_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !CLAIM_SECRET_ENC_KEY) {
  console.error("Missing env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CLAIM_SECRET_ENC_KEY");
  console.error("Tip: run with `node --env-file=.env.local scripts/provision-device.mjs`");
  process.exit(1);
}

const deviceType = arg("--type", "humid-sht31");
// NVS namespace must match the firmware's NVS_NAMESPACE (Storage). humid uses
// "humid"; the IR blaster uses "irblast". Pass --namespace to override.
//   node --env-file=.env.local scripts/provision-device.mjs --type ir-blaster-esp32c3 --namespace irblast
const namespace = arg("--namespace", "humid");
const publicDeviceId = randomUUID();
const secret = randomBytes(32);
const secretEnc = encryptSecret(secret, CLAIM_SECRET_ENC_KEY);

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { error } = await supabase.from("devices").insert({
  public_device_id: publicDeviceId,
  device_type: deviceType,
  claim_secret_enc: secretEnc,
  claim_state: "unclaimed",
});
if (error) {
  console.error("DB insert failed:", error.message);
  process.exit(1);
}

// NVS CSV for esp-idf's nvs_partition_gen.py. The namespace must match the
// firmware (Storage / NVS_NAMESPACE). pubid -> getString, secret -> getBytes.
const csv = [
  "key,type,encoding,value",
  `${namespace},namespace,,`,
  `pubid,data,string,${publicDeviceId}`,
  `secret,data,hex2bin,${secret.toString("hex")}`,
  "",
].join("\n");

const outDir = join("provisioning", publicDeviceId);
mkdirSync(outDir, { recursive: true });
const csvPath = join(outDir, "nvs.csv");
writeFileSync(csvPath, csv, { mode: 0o600 });

console.log("Registered device:");
console.log("  public_device_id:", publicDeviceId);
console.log("  device_type:     ", deviceType);
console.log("  nvs_namespace:   ", namespace);
console.log("  claim_state:      unclaimed (secret stored encrypted)");
console.log("\nNVS CSV written to:", csvPath);
const binPath = join(outDir, "nvs.bin");
console.log("\nNext steps (flash BEFORE Wi-Fi setup — flashing NVS wipes stored Wi-Fi creds):");
console.log("  # 1. One-time: install the NVS image generator");
console.log("  pip install esp-idf-nvs-partition-gen");
console.log("  # 2. Build the NVS image. Size 0x5000 + offset 0x9000 match min_spiffs.csv;");
console.log("  #    confirm against your board_build.partitions if you changed it.");
console.log(`  python -m esp_idf_nvs_partition_gen generate ${csvPath} ${binPath} 0x5000`);
console.log("  # 3. Flash it at the nvs partition offset (set PORT to your device):");
console.log(`  python -m esptool --port PORT write_flash 0x9000 ${binPath}`);
console.log("\nThe app firmware is identical across units; only this NVS image is per-device.");
