// Shared token check for device-facing endpoints (ingest + firmware download).
// Supports rotation: a transitional INGEST_TOKEN_LEGACY env var lets the
// backend accept the *previous* token while a fleet OTA rolls out, then gets
// deleted after every device is on the new firmware.
import { timingSafeEqual } from "crypto";

function safeEquals(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function tokenOk(provided: string | null): boolean {
  if (!provided) return false;
  const primary = process.env.INGEST_TOKEN;
  if (primary && safeEquals(provided, primary)) return true;
  // Optional legacy token, set during a fleet OTA rotation. Remove from env
  // after every device has upgraded to the new firmware.
  const legacy = process.env.INGEST_TOKEN_LEGACY;
  if (legacy && safeEquals(provided, legacy)) return true;
  return false;
}
