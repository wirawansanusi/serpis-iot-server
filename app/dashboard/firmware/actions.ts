"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createHash } from "crypto";
import { supabase } from "@/lib/supabase";
import { adminUserId } from "@/lib/admin";
import { putTencentCosObject, deleteTencentCosObject, isTencentCosConfigured } from "@/lib/tencent-cos";

const VERSION_RE = /^[a-zA-Z0-9][a-zA-Z0-9.\-+_]{0,31}$/;
const TYPE_RE = /^[a-z0-9][a-z0-9\-_]{0,63}$/;
const MAX_BIN_BYTES = 8 * 1024 * 1024; // generous ceiling for an ESP32 app image

function fail(msg: string): never {
  redirect(`/dashboard/firmware?error=${encodeURIComponent(msg)}`);
}

// Upload a firmware artifact to COS and register the release (disabled by
// default — enable it explicitly to start offering). sha256 + size are computed
// server-side from the exact bytes so the ingest offer and download agree.
export async function uploadRelease(formData: FormData): Promise<void> {
  if (!adminUserId()) redirect("/dashboard");
  const userId = adminUserId()!;
  if (!isTencentCosConfigured()) fail("Tencent COS is not configured on the server");

  const deviceType = String(formData.get("device_type") ?? "").trim();
  const version = String(formData.get("version") ?? "").trim();
  const releaseNotes = String(formData.get("release_notes") ?? "").trim() || null;
  const minCurrent = String(formData.get("min_current_version") ?? "").trim() || null;
  const maxCurrent = String(formData.get("max_current_version") ?? "").trim() || null;
  const mandatory = formData.get("mandatory") === "on";
  const file = formData.get("file");

  if (!TYPE_RE.test(deviceType)) fail("Invalid device type");
  if (!VERSION_RE.test(version)) fail("Invalid version");
  if (!(file instanceof File) || file.size === 0) fail("Choose a .bin file");
  if (file.size > MAX_BIN_BYTES) fail("Firmware file is too large");

  // Enforce immutability: a (device_type, version) can only be registered once.
  const { data: existing } = await supabase
    .from("firmware_releases")
    .select("id")
    .eq("device_type", deviceType)
    .eq("version", version)
    .maybeSingle();
  if (existing) fail(`Release ${deviceType} ${version} already exists — bump the version`);

  const bytes = Buffer.from(await (file as File).arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const cosKey = `firmware/${deviceType}/${version}.bin`;

  try {
    await putTencentCosObject({ key: cosKey, body: bytes, contentType: "application/octet-stream", contentLength: bytes.length });
  } catch (e: any) {
    console.error("[uploadRelease] COS put failed", e?.message ?? e);
    fail("Upload to storage failed");
  }

  const { error } = await supabase.from("firmware_releases").insert({
    device_type: deviceType,
    version,
    cos_key: cosKey,
    sha256,
    size_bytes: bytes.length,
    release_notes: releaseNotes,
    min_current_version: minCurrent,
    max_current_version: maxCurrent,
    enabled: false,
    mandatory,
    created_by: userId,
  });
  if (error) {
    console.error("[uploadRelease] insert failed", error);
    // Roll back the orphaned object so a retry can re-upload cleanly.
    await deleteTencentCosObject(cosKey).catch(() => {});
    fail("Could not register release");
  }

  revalidatePath("/dashboard/firmware");
  redirect("/dashboard/firmware?ok=Release+uploaded");
}

export async function setReleaseEnabled(formData: FormData): Promise<void> {
  if (!adminUserId()) redirect("/dashboard");
  const id = String(formData.get("id") ?? "");
  const enabled = formData.get("enabled") === "true";
  if (!id) return;
  const { error } = await supabase.from("firmware_releases").update({ enabled }).eq("id", id);
  if (error) console.error("[setReleaseEnabled]", error);
  revalidatePath("/dashboard/firmware");
}

export async function setReleaseMandatory(formData: FormData): Promise<void> {
  if (!adminUserId()) redirect("/dashboard");
  const id = String(formData.get("id") ?? "");
  const mandatory = formData.get("mandatory") === "true";
  if (!id) return;
  const { error } = await supabase.from("firmware_releases").update({ mandatory }).eq("id", id);
  if (error) console.error("[setReleaseMandatory]", error);
  revalidatePath("/dashboard/firmware");
}

export async function deleteRelease(formData: FormData): Promise<void> {
  if (!adminUserId()) redirect("/dashboard");
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const { data: rel } = await supabase.from("firmware_releases").select("cos_key").eq("id", id).maybeSingle();
  const { error } = await supabase.from("firmware_releases").delete().eq("id", id);
  if (error) {
    console.error("[deleteRelease]", error);
    return;
  }
  if (rel?.cos_key) await deleteTencentCosObject(rel.cos_key).catch((e) => console.error("[deleteRelease] COS", e));
  revalidatePath("/dashboard/firmware");
}
