// Crypto for the BLE device-claiming flow. The proof scheme is byte-exact across
// three layers (this backend, the ESP32 firmware via mbedTLS, the Expo app), so
// keep the message construction here identical to scripts/claim-sim.mjs and the
// firmware self-test. See device-claiming-prd.md § Claim Protocol.

import { createHmac, createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "crypto";

// Canonical proof message. "|"-delimited to avoid concatenation ambiguity.
// nonce/challenge are passed as the base64url strings exactly as transmitted.
export function buildProofMessage(
  publicDeviceId: string,
  claimNonceB64url: string,
  serverChallengeB64url: string,
): string {
  return `${publicDeviceId}|${claimNonceB64url}|${serverChallengeB64url}`;
}

// claim_proof = lowercase hex of HMAC_SHA256(claim_secret, msg).
export function computeProof(
  claimSecret: Buffer,
  publicDeviceId: string,
  claimNonceB64url: string,
  serverChallengeB64url: string,
): string {
  const msg = buildProofMessage(publicDeviceId, claimNonceB64url, serverChallengeB64url);
  return createHmac("sha256", claimSecret).update(msg, "utf8").digest("hex");
}

// Timing-safe comparison of two hex proofs.
export function verifyProof(expectedHex: string, providedHex: string): boolean {
  if (typeof providedHex !== "string" || providedHex.length !== expectedHex.length) return false;
  const a = Buffer.from(expectedHex, "hex");
  const b = Buffer.from(providedHex, "hex");
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

// Random base64url token (used for server_challenge: 32 bytes).
export function randomB64url(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function encKey(): Buffer {
  const raw = process.env.CLAIM_SECRET_ENC_KEY;
  if (!raw) throw new Error("Missing CLAIM_SECRET_ENC_KEY");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("CLAIM_SECRET_ENC_KEY must be 32 bytes (base64-encoded)");
  return key;
}

// AES-256-GCM. Stored value is base64( iv(12) || tag(16) || ciphertext ).
export function encryptSecret(claimSecret: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encKey(), iv);
  const ct = Buffer.concat([cipher.update(claimSecret), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64");
}

export function decryptSecret(enc: string): Buffer {
  const raw = Buffer.from(enc, "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", encKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}
