#!/usr/bin/env node
// Claim-flow reference + verification tool. Plain-JS reimplementation of the
// canonical proof (must match lib/claim-crypto.ts and the firmware mbedTLS code).
//
//   node scripts/claim-sim.mjs selftest
//       Pin the message construction and print the proof for the fixed test
//       vector. Copy the printed hex into the firmware serial self-test so a
//       mismatch reveals a firmware/byte-construction bug.
//
//   node scripts/claim-sim.mjs claim <baseUrl> <public_device_id> <secret_hex>
//       Simulate the mobile app end-to-end against a running backend. Requires a
//       Clerk session token in CLERK_TOKEN (sent as Authorization: Bearer ...).

import { createHmac, randomBytes } from "crypto";

function buildProofMessage(publicDeviceId, nonceB64, challengeB64) {
  return `${publicDeviceId}|${nonceB64}|${challengeB64}`;
}
function computeProof(secret, publicDeviceId, nonceB64, challengeB64) {
  return createHmac("sha256", secret)
    .update(buildProofMessage(publicDeviceId, nonceB64, challengeB64), "utf8")
    .digest("hex");
}

// Fixed test vector — byte-identical inputs every layer must reproduce.
const VECTOR = {
  secret: Buffer.from(Array.from({ length: 32 }, (_, i) => i)), // 0x00..0x1f
  publicDeviceId: "11111111-2222-3333-4444-555555555555",
  nonceB64: Buffer.from(Array.from({ length: 16 }, (_, i) => i)).toString("base64url"),
  challengeB64: Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString("base64url"),
  expectedMsg:
    "11111111-2222-3333-4444-555555555555|AAECAwQFBgcICQoLDA0ODw|AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
};

function selftest() {
  const msg = buildProofMessage(VECTOR.publicDeviceId, VECTOR.nonceB64, VECTOR.challengeB64);
  if (msg !== VECTOR.expectedMsg) {
    console.error("FAIL: message mismatch\n  got:      %s\n  expected: %s", msg, VECTOR.expectedMsg);
    process.exit(1);
  }
  const proof = computeProof(VECTOR.secret, VECTOR.publicDeviceId, VECTOR.nonceB64, VECTOR.challengeB64);
  if (!/^[0-9a-f]{64}$/.test(proof)) {
    console.error("FAIL: proof is not 64 lowercase hex chars: %s", proof);
    process.exit(1);
  }
  console.log("OK message construction pinned.");
  console.log("message:  %s", msg);
  console.log("proof:    %s", proof);
  console.log("\nHardcode the proof above into the firmware serial self-test (Phase B).");
}

async function claim(baseUrl, publicDeviceId, secretHex) {
  const token = process.env.CLERK_TOKEN;
  if (!token) throw new Error("Set CLERK_TOKEN (a Clerk session JWT) in the environment");
  const secret = Buffer.from(secretHex, "hex");
  const nonceB64 = randomBytes(16).toString("base64url"); // app stands in for the device nonce
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  const startRes = await fetch(`${baseUrl}/api/devices/claim/start`, {
    method: "POST",
    headers,
    body: JSON.stringify({ public_device_id: publicDeviceId }),
  });
  const start = await startRes.json();
  console.log("start ->", startRes.status, start);
  if (!startRes.ok) process.exit(1);

  const proof = computeProof(secret, publicDeviceId, nonceB64, start.server_challenge);
  const completeRes = await fetch(`${baseUrl}/api/devices/claim/complete`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      public_device_id: publicDeviceId,
      claim_nonce: nonceB64,
      server_challenge: start.server_challenge,
      claim_proof: proof,
    }),
  });
  console.log("complete ->", completeRes.status, await completeRes.json());
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === "selftest") selftest();
else if (cmd === "claim") await claim(args[0], args[1], args[2]);
else {
  console.error("usage: claim-sim.mjs selftest | claim <baseUrl> <public_device_id> <secret_hex>");
  process.exit(2);
}
