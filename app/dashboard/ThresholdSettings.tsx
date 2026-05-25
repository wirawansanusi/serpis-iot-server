import type { DeviceMetric } from "@/lib/metrics";
import { setThreshold } from "./actions";

// Per-metric alert bounds editor. One row per metric the device reports; a blank
// field means "no bound on that side". Submits the server action setThreshold.
export function ThresholdSettings({
  deviceId,
  metrics,
}: {
  deviceId: string;
  metrics: DeviceMetric[];
}) {
  return (
    <details className="thresholds">
      <summary>Alert thresholds</summary>
      <div className="thr-list">
        {metrics.map((m) => (
          <form key={m.key} action={setThreshold} className="thr-row">
            <input type="hidden" name="deviceId" value={deviceId} />
            <input type="hidden" name="metric_key" value={m.key} />
            <span className="thr-label">
              {m.label}
              {m.unit ? ` (${m.unit})` : ""}
            </span>
            <input name="min_val" type="number" step="any" defaultValue={m.min_val ?? ""} placeholder="min" aria-label={`${m.label} minimum`} />
            <input name="max_val" type="number" step="any" defaultValue={m.max_val ?? ""} placeholder="max" aria-label={`${m.label} maximum`} />
            <button type="submit">Save</button>
          </form>
        ))}
      </div>
    </details>
  );
}
