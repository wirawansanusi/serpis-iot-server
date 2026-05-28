import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { supabase } from "@/lib/supabase";
import { findDownloadableRelease } from "@/lib/ota";
import { getTencentCosObject } from "@/lib/tencent-cos";
import { tokenOk } from "@/lib/device-auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: { deviceType: string; version: string } }) {
  if (!tokenOk(req.headers.get("x-device-token"))) {
    return NextResponse.json({ error: "invalid token" }, { status: 401 });
  }

  const deviceType = decodeURIComponent(params.deviceType);
  const version = decodeURIComponent(params.version);
  const publicDeviceId = req.headers.get("x-public-device-id");
  if (!publicDeviceId) {
    return NextResponse.json({ error: "missing X-Public-Device-Id" }, { status: 400 });
  }

  // The requesting device must exist, be claimed, and be of the release's type.
  const { data: device } = await supabase
    .from("devices")
    .select("device_type, claim_state")
    .eq("public_device_id", publicDeviceId)
    .maybeSingle();
  if (!device || device.claim_state !== "claimed" || device.device_type !== deviceType) {
    return NextResponse.json({ error: "device not authorized for this release" }, { status: 403 });
  }

  const release = await findDownloadableRelease(deviceType, version);
  if (!release) {
    return NextResponse.json({ error: "release not found" }, { status: 404 });
  }

  let bytes: Buffer;
  try {
    bytes = await getTencentCosObject(release.cos_key);
  } catch (e: any) {
    console.error("[firmware/download] COS fetch failed", release.cos_key, e?.message ?? e);
    return NextResponse.json({ error: "firmware unavailable" }, { status: 502 });
  }

  // Integrity guard: the bytes we serve must match the registered size + hash,
  // otherwise the device would download something the offer didn't promise.
  if (bytes.length !== release.size_bytes) {
    console.error("[firmware/download] size mismatch", release.cos_key, bytes.length, release.size_bytes);
    return NextResponse.json({ error: "firmware size mismatch" }, { status: 500 });
  }
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (sha !== release.sha256.toLowerCase()) {
    console.error("[firmware/download] sha256 mismatch", release.cos_key);
    return NextResponse.json({ error: "firmware integrity check failed" }, { status: 500 });
  }

  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(release.size_bytes),
      "Cache-Control": "no-store",
      "X-Firmware-Version": release.version,
      "X-Firmware-SHA256": release.sha256.toLowerCase(),
    },
  });
}
