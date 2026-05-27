import { auth } from "@clerk/nextjs/server";
import { supabase } from "@/lib/supabase";
import { isAdminUser } from "@/lib/admin";
import { isTencentCosConfigured } from "@/lib/tencent-cos";
import { uploadRelease, setReleaseEnabled, setReleaseMandatory, deleteRelease } from "./actions";

export const dynamic = "force-dynamic";

type Release = {
  id: string;
  device_type: string;
  version: string;
  sha256: string;
  size_bytes: number;
  release_notes: string | null;
  min_current_version: string | null;
  max_current_version: string | null;
  enabled: boolean;
  mandatory: boolean;
  created_at: string;
};

type OtaStatusRow = {
  device_id: string;
  target_version: string | null;
  ota_state: string;
  last_status: string | null;
  last_message: string | null;
  last_at: string | null;
  devices: { name: string | null; mac: string | null; firmware_version: string | null } | null;
};

function fmtSize(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export default async function FirmwarePage({ searchParams }: { searchParams: { ok?: string; error?: string } }) {
  const { userId } = auth();
  if (!isAdminUser(userId)) {
    return (
      <div className="empty">Firmware management is restricted to administrators.</div>
    );
  }

  const { data: releaseData } = await supabase
    .from("firmware_releases")
    .select("*")
    .order("device_type", { ascending: true })
    .order("created_at", { ascending: false });
  const releases = (releaseData ?? []) as Release[];

  const { data: otaData } = await supabase
    .from("device_ota")
    .select("device_id, target_version, ota_state, last_status, last_message, last_at, devices(name, mac, firmware_version)")
    .order("last_at", { ascending: false, nullsFirst: false });
  const otaRows = (otaData ?? []) as unknown as OtaStatusRow[];

  return (
    <div>
      <h1>Firmware</h1>

      {searchParams.ok ? <div className="notice ok">{searchParams.ok}</div> : null}
      {searchParams.error ? <div className="notice err">{searchParams.error}</div> : null}
      {!isTencentCosConfigured() ? (
        <div className="notice err">Tencent COS env vars are not configured — uploads will fail.</div>
      ) : null}

      <h2 className="section">Upload release</h2>
      <form action={uploadRelease} className="stack fw-upload">
        <label>
          Device type
          <input name="device_type" defaultValue="humid-sht31" maxLength={64} required />
        </label>
        <label>
          Version
          <input name="version" placeholder="0.3.0" maxLength={32} required />
        </label>
        <label>
          Firmware binary (.bin)
          <input name="file" type="file" accept=".bin,application/octet-stream" required />
        </label>
        <label>
          Release notes
          <input name="release_notes" placeholder="What changed" maxLength={500} />
        </label>
        <div className="fw-range">
          <label>
            Min current version
            <input name="min_current_version" placeholder="any" maxLength={32} />
          </label>
          <label>
            Max current version
            <input name="max_current_version" placeholder="any" maxLength={32} />
          </label>
        </div>
        <label className="fw-check">
          <input name="mandatory" type="checkbox" /> Mandatory (auto-offer to all matching devices)
        </label>
        <button type="submit">Upload &amp; register</button>
      </form>
      <p className="foot" style={{ textAlign: "left" }}>
        Releases register disabled. SHA-256 and size are computed from the uploaded bytes. Enable a release to start offering it.
      </p>

      <h2 className="section">Releases</h2>
      {releases.length === 0 ? (
        <div className="empty">No firmware releases yet.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>Version</th>
              <th>Size</th>
              <th>Applies to</th>
              <th>Enabled</th>
              <th>Mandatory</th>
              <th>Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {releases.map((r) => (
              <tr key={r.id}>
                <td className="kind">{r.device_type}</td>
                <td>
                  <strong>{r.version}</strong>
                  {r.release_notes ? <div className="row-meta">{r.release_notes}</div> : null}
                  <div className="kind" title={r.sha256}>{r.sha256.slice(0, 12)}…</div>
                </td>
                <td>{fmtSize(r.size_bytes)}</td>
                <td className="kind">
                  {r.min_current_version || "*"} – {r.max_current_version || "*"}
                </td>
                <td>
                  <form action={setReleaseEnabled}>
                    <input type="hidden" name="id" value={r.id} />
                    <input type="hidden" name="enabled" value={r.enabled ? "false" : "true"} />
                    <button type="submit" className={r.enabled ? "" : "primary"}>
                      {r.enabled ? "Disable" : "Enable"}
                    </button>
                  </form>
                </td>
                <td>
                  <form action={setReleaseMandatory}>
                    <input type="hidden" name="id" value={r.id} />
                    <input type="hidden" name="mandatory" value={r.mandatory ? "false" : "true"} />
                    <button type="submit">{r.mandatory ? "Yes" : "No"}</button>
                  </form>
                </td>
                <td className="row-meta">{new Date(r.created_at).toLocaleDateString()}</td>
                <td>
                  <form action={deleteRelease}>
                    <input type="hidden" name="id" value={r.id} />
                    <button type="submit" className="danger">Delete</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 className="section">Device update status</h2>
      {otaRows.length === 0 ? (
        <div className="empty">No devices have OTA state yet.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Device</th>
              <th>Running</th>
              <th>Target</th>
              <th>State</th>
              <th>Last report</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {otaRows.map((row) => (
              <tr key={row.device_id}>
                <td>{row.devices?.name ?? row.devices?.mac ?? row.device_id.slice(0, 8)}</td>
                <td>{row.devices?.firmware_version ?? "—"}</td>
                <td>{row.target_version ?? "—"}</td>
                <td className="kind">{row.ota_state}</td>
                <td>
                  {row.last_status ?? "—"}
                  {row.last_message ? <div className="row-meta">{row.last_message}</div> : null}
                </td>
                <td className="row-meta">{row.last_at ? new Date(row.last_at).toLocaleString() : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
