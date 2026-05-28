// OTA firmware update logic, shared by the ingest route (compute offers + record
// device-reported status), the dashboard route (mobile-facing summary), and the
// mobile action endpoints (start / retry).
//
// Model (MVP, per ota-firmware-update-prd.md): `firmware_releases` holds the
// artifacts; `device_ota` holds per-device state. An optional release is only
// offered after the user opts in (update_requested_version); a `mandatory`
// release is offered to every matching device automatically. A failed/rolled
// back version is blocked until the user retries.
import { supabase } from "@/lib/supabase";

export const OTA_INSTALLING_TIMEOUT_MS = 10 * 60 * 1000;
export const OTA_MIN_BATTERY_PERCENT = 30;

export type FirmwareRelease = {
  id: string;
  device_type: string;
  version: string;
  cos_key: string;
  sha256: string;
  size_bytes: number;
  release_notes: string | null;
  min_current_version: string | null;
  max_current_version: string | null;
  enabled: boolean;
  mandatory: boolean;
  created_at: string;
};

export type DeviceOtaRow = {
  device_id: string;
  target_version: string | null;
  ota_state: string;
  update_requested_version: string | null;
  failed_version: string | null;
  offered_at: string | null;
  last_status: string | null;
  last_error_code: number | null;
  last_message: string | null;
  last_at: string | null;
};

export type OtaOffer = {
  available: true;
  version: string;
  url: string;
  sha256: string;
  size: number;
  mandatory: boolean;
};

export type OtaStatusReport = {
  status: string;
  target_version?: string;
  running_version?: string;
  error_code?: number;
  message?: string;
};

export type MobileFirmwareState =
  | "up_to_date"
  | "available"
  | "scheduled"
  | "installing"
  | "installed"
  | "failed"
  | "deferred";

export type MobileFirmware = {
  current_version: string | null;
  latest_version: string | null;
  state: MobileFirmwareState;
  mandatory: boolean;
  release_notes: string | null;
  last_status: string | null;
  last_message: string | null;
  last_updated_at: string | null;
  low_battery_warning: boolean;
};

type DeviceLike = {
  id: string;
  device_type: string | null;
  firmware_version: string | null;
  battery_percent: number | null;
  power_source: string | null;
};

// --- Version comparison --------------------------------------------------

// Parse a semver-ish "x.y.z" core (ignores any -prerelease / +build). Returns
// null for anything non-numeric so callers can fall back to string equality.
function parseVersion(v: string): number[] | null {
  const core = v.trim().replace(/^v/i, "").split("-")[0].split("+")[0];
  const nums = core.split(".").map((p) => Number(p));
  if (nums.length === 0 || nums.some((n) => !Number.isInteger(n) || n < 0)) return null;
  return nums;
}

// -1 / 0 / 1, or null when either side isn't parseable as semver.
export function compareVersions(a: string, b: string): number | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function versionsDiffer(current: string, target: string): boolean {
  const cmp = compareVersions(current, target);
  return cmp === null ? current.trim() !== target.trim() : cmp !== 0;
}

// Inclusive range check; an unparseable or null bound is treated as no bound.
function currentInRange(current: string, min: string | null, max: string | null): boolean {
  if (min) {
    const cmp = compareVersions(current, min);
    if (cmp !== null && cmp < 0) return false;
  }
  if (max) {
    const cmp = compareVersions(current, max);
    if (cmp !== null && cmp > 0) return false;
  }
  return true;
}

// --- Release selection ---------------------------------------------------

// Best enabled release for this device type that applies to `currentVersion`
// (differs from current, current within version range), preferring the highest
// version (semver, falling back to newest created_at).
export async function findBestEnabledRelease(
  deviceType: string,
  currentVersion: string | null,
): Promise<FirmwareRelease | null> {
  const { data, error } = await supabase
    .from("firmware_releases")
    .select("*")
    .eq("device_type", deviceType)
    .eq("enabled", true);
  if (error) {
    console.error("[ota] findBestEnabledRelease", error);
    return null;
  }

  const candidates = (data as FirmwareRelease[]).filter((r) => {
    if (currentVersion && !versionsDiffer(currentVersion, r.version)) return false;
    if (currentVersion && !currentInRange(currentVersion, r.min_current_version, r.max_current_version)) return false;
    return true;
  });
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    const cmp = compareVersions(b.version, a.version);
    if (cmp !== null && cmp !== 0) return cmp;
    return b.created_at.localeCompare(a.created_at);
  });
  return candidates[0];
}

async function getDeviceOta(deviceId: string): Promise<DeviceOtaRow | null> {
  const { data } = await supabase.from("device_ota").select("*").eq("device_id", deviceId).maybeSingle();
  return (data as DeviceOtaRow) ?? null;
}

async function upsertDeviceOta(deviceId: string, patch: Partial<DeviceOtaRow>): Promise<void> {
  const { error } = await supabase
    .from("device_ota")
    .upsert({ device_id: deviceId, ...patch, updated_at: new Date().toISOString() }, { onConflict: "device_id" });
  if (error) console.error("[ota] upsertDeviceOta", error);
}

// --- Ingest-time logic ---------------------------------------------------

// Persist a device-reported ota_status and move the per-device state machine.
// Forward-compatible: unknown status strings are stored without state change.
export async function persistOtaStatus(deviceId: string, report: OtaStatusReport): Promise<void> {
  const base: Partial<DeviceOtaRow> = {
    last_status: report.status,
    last_error_code: typeof report.error_code === "number" ? report.error_code : null,
    last_message: typeof report.message === "string" ? report.message.slice(0, 500) : null,
    last_at: new Date().toISOString(),
  };
  const target = report.target_version ?? null;

  switch (report.status) {
    case "installed":
      // Booted and self-validated. Clear the opt-in so we don't re-offer.
      await upsertDeviceOta(deviceId, {
        ...base,
        ota_state: "installed",
        target_version: target,
        update_requested_version: null,
        failed_version: null,
      });
      break;
    case "failed":
      // Block re-offering this version until the user retries.
      await upsertDeviceOta(deviceId, { ...base, ota_state: "failed", failed_version: target });
      break;
    case "rolled_back":
      await upsertDeviceOta(deviceId, { ...base, ota_state: "rolled_back", failed_version: target });
      break;
    case "deferred":
      await upsertDeviceOta(deviceId, { ...base, ota_state: "deferred" });
      break;
    default:
      await upsertDeviceOta(deviceId, base);
  }
}

// Compute the OTA offer to attach to an ingest response, if any. Updates
// device_ota to `offered` when an offer is returned. `baseUrl` is the public
// origin the device reaches us on (must be our pinned-cert domain).
export async function computeIngestOffer(device: DeviceLike, baseUrl: string): Promise<OtaOffer | null> {
  if (!device.device_type) return null;

  const best = await findBestEnabledRelease(device.device_type, device.firmware_version);
  if (!best) return null;

  const ota = await getDeviceOta(device.id);

  // Blocked after a failure/rollback on this exact version until Retry clears it.
  if (ota?.failed_version && !versionsDiffer(best.version, ota.failed_version)) return null;

  // Optional releases require an explicit opt-in (the user tapping "Update now"
  // in the app). Mandatory releases are offered automatically.
  if (!best.mandatory) {
    const optedIn = ota?.update_requested_version && !versionsDiffer(best.version, ota.update_requested_version);
    if (!optedIn) return null;
  }

  const url = `${baseUrl.replace(/\/$/, "")}/api/firmware/download/${encodeURIComponent(device.device_type)}/${encodeURIComponent(best.version)}`;

  await upsertDeviceOta(device.id, {
    ota_state: "offered",
    target_version: best.version,
    offered_at: new Date().toISOString(),
  });

  return {
    available: true,
    version: best.version,
    url,
    sha256: best.sha256,
    size: best.size_bytes,
    mandatory: best.mandatory,
  };
}

// --- Download authorization ----------------------------------------------

// The release a device is allowed to download for (deviceType, version): must
// exist and be enabled. (Device identity/claim is checked by the route.)
export async function findDownloadableRelease(deviceType: string, version: string): Promise<FirmwareRelease | null> {
  const { data } = await supabase
    .from("firmware_releases")
    .select("*")
    .eq("device_type", deviceType)
    .eq("version", version)
    .eq("enabled", true)
    .maybeSingle();
  return (data as FirmwareRelease) ?? null;
}

// --- Mobile-facing summary -----------------------------------------------

export async function buildMobileFirmware(device: DeviceLike): Promise<MobileFirmware> {
  const current = device.firmware_version;
  const best = device.device_type ? await findBestEnabledRelease(device.device_type, current) : null;
  const ota = await getDeviceOta(device.id);

  const lowBattery =
    device.power_source === "battery" &&
    typeof device.battery_percent === "number" &&
    device.battery_percent < OTA_MIN_BATTERY_PERCENT;

  const state = deriveMobileState(current, best, ota);

  return {
    current_version: current,
    latest_version: best?.version ?? current,
    state,
    mandatory: best?.mandatory ?? false,
    release_notes: best?.release_notes ?? null,
    last_status: ota?.last_status ?? null,
    last_message: ota?.last_message ?? null,
    last_updated_at: ota?.last_at ?? null,
    low_battery_warning: state !== "up_to_date" && lowBattery,
  };
}

function deriveMobileState(
  current: string | null,
  best: FirmwareRelease | null,
  ota: DeviceOtaRow | null,
): MobileFirmwareState {
  // A terminal report on the version we're targeting takes precedence.
  if (ota) {
    const matchesTarget = (v: string | null) =>
      v != null && ota.target_version != null && !versionsDiffer(v, ota.target_version);

    if (ota.ota_state === "installed" && (!best || matchesTarget(best.version))) return "installed";
    if ((ota.ota_state === "failed" || ota.ota_state === "rolled_back") && matchesTarget(best?.version ?? null)) {
      return "failed";
    }
    if (ota.ota_state === "deferred") return "deferred";

    // Offered and awaiting the device's result, within the staleness window.
    if (ota.ota_state === "offered" && ota.offered_at) {
      const fresh = Date.now() - new Date(ota.offered_at).getTime() < OTA_INSTALLING_TIMEOUT_MS;
      if (fresh) return "installing";
    }
  }

  if (!best) return "up_to_date";

  // User opted into this version but the device hasn't been offered yet.
  if (ota?.update_requested_version && !versionsDiffer(best.version, ota.update_requested_version)) {
    return "scheduled";
  }
  return "available";
}

// --- Mobile actions ------------------------------------------------------

// Start update: opt this device into the latest applicable release.
export async function requestUpdate(device: DeviceLike): Promise<MobileFirmware> {
  const best = device.device_type ? await findBestEnabledRelease(device.device_type, device.firmware_version) : null;
  if (best) {
    await upsertDeviceOta(device.id, {
      update_requested_version: best.version,
      ota_state: "available",
    });
  }
  return buildMobileFirmware(device);
}

// Retry: clear the failure block and re-opt-in to the latest release.
export async function retryUpdate(device: DeviceLike): Promise<MobileFirmware> {
  const best = device.device_type ? await findBestEnabledRelease(device.device_type, device.firmware_version) : null;
  if (best) {
    await upsertDeviceOta(device.id, {
      update_requested_version: best.version,
      failed_version: null,
      ota_state: "available",
    });
  }
  return buildMobileFirmware(device);
}
