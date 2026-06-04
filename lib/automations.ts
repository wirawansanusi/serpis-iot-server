// If-then automation engine. Evaluated at ingest time (after the reading lands,
// alongside push-alert evaluation) against the owner's enabled rules for the
// trigger (device, metric). On a rising edge — gated by cooldown + active hours,
// re-armed past a hysteresis deadband — it fires an IR command on the action
// device via MQTT. See supabase/migrate_automations.sql.
import { randomUUID } from "crypto";
import { supabase } from "@/lib/supabase";
import { publishCommand } from "@/lib/mqtt";
import { validateCommand, type IrCommand } from "@/lib/ir";

export type AutomationOperator = "gt" | "lt";
export type ActiveHours = { start: number; end: number; tz_offset_minutes: number } | null;

type AutomationRow = {
  id: string;
  owner_user_id: string;
  name: string;
  trigger_device_id: string;
  metric_key: string;
  operator: AutomationOperator;
  threshold: number;
  clear_threshold: number | null;
  action_device_id: string;
  action: IrCommand;
  cooldown_minutes: number;
  active_hours: ActiveHours;
  is_active: boolean;
  last_fired_at: string | null;
};

function withinActiveHours(ah: ActiveHours, nowMs: number): boolean {
  if (!ah) return true;
  if (ah.start === ah.end) return true; // all day
  const localHour = Math.floor(((nowMs / 3_600_000 + ah.tz_offset_minutes / 60) % 24 + 24) % 24);
  return ah.start < ah.end
    ? localHour >= ah.start && localHour < ah.end
    : localHour >= ah.start || localHour < ah.end; // wraps midnight
}

// Fire one automation's action: record it in device_commands (audit + ack) and
// publish over MQTT. Re-checks ownership + device type at fire time, since the
// action device could have been handed off since the rule was created.
async function fireAction(a: AutomationRow): Promise<void> {
  const { data: dev } = await supabase
    .from("devices")
    .select("public_device_id, owner_user_id, device_type")
    .eq("id", a.action_device_id)
    .maybeSingle();
  if (!dev || dev.owner_user_id !== a.owner_user_id || dev.device_type !== "ir-blaster-esp32c3") {
    console.warn(`[automations] skip fire ${a.id}: action device not a usable ir-blaster`);
    return;
  }

  const id = randomUUID();
  const command = { ...a.action, id };
  await supabase.from("device_commands").insert({
    id,
    device_id: a.action_device_id,
    command,
    created_by: a.owner_user_id,
    status: "queued",
  });
  const sent = await publishCommand(dev.public_device_id, command);
  if (sent) {
    await supabase
      .from("device_commands")
      .update({ status: "sent", sent_at: new Date().toISOString() })
      .eq("id", id);
  }
  console.log(`[automations] fired ${a.id} -> ${a.action_device_id} (${sent ? "sent" : "queued"})`);
}

// Evaluate every enabled rule watching this device for the metrics just ingested.
// Safe to call on every claimed reading; no-ops unless rules exist. Never throws
// to the caller — failures are logged so they can't break ingest.
export async function evaluateAutomations(opts: {
  triggerDeviceId: string;
  ownerUserId: string | null;
  metrics: { key: string; value: number }[];
  recordedAtMs: number;
}): Promise<void> {
  const { triggerDeviceId, ownerUserId, metrics, recordedAtMs } = opts;
  if (!ownerUserId || metrics.length === 0) return;

  const { data, error } = await supabase
    .from("automations")
    .select(
      "id, owner_user_id, name, trigger_device_id, metric_key, operator, threshold, clear_threshold, action_device_id, action, cooldown_minutes, active_hours, is_active, last_fired_at",
    )
    .eq("trigger_device_id", triggerDeviceId)
    .eq("owner_user_id", ownerUserId)
    .eq("enabled", true);
  if (error) {
    console.error("[automations] load failed", error.message);
    return;
  }
  const rules = (data ?? []) as AutomationRow[];
  if (rules.length === 0) return;

  const valueByKey = new Map(metrics.map((m) => [m.key, m.value]));

  for (const a of rules) {
    const value = valueByKey.get(a.metric_key);
    if (value === undefined) continue;

    const breached = a.operator === "gt" ? value > a.threshold : value < a.threshold;
    const cleared =
      a.clear_threshold === null
        ? !breached
        : a.operator === "gt"
          ? value <= a.clear_threshold
          : value >= a.clear_threshold;

    let nextActive = a.is_active;
    let fired = false;

    if (breached && !a.is_active) {
      // Rising edge: latch so we don't re-fire every reading while it stays
      // breached. Fire only if cooldown + active hours allow.
      nextActive = true;
      const lastMs = a.last_fired_at ? Date.parse(a.last_fired_at) : 0;
      const cooldownOk = lastMs === 0 || recordedAtMs - lastMs >= a.cooldown_minutes * 60_000;
      if (cooldownOk && withinActiveHours(a.active_hours, recordedAtMs)) {
        try {
          await fireAction(a);
          fired = true;
        } catch (e) {
          console.error(`[automations] fire ${a.id} failed`, e);
        }
      }
    } else if (cleared && a.is_active) {
      nextActive = false; // falling edge past the deadband: re-arm
    }

    if (nextActive !== a.is_active || fired) {
      const patch: Record<string, unknown> = { is_active: nextActive, updated_at: new Date().toISOString() };
      if (fired) patch.last_fired_at = new Date(recordedAtMs).toISOString();
      await supabase.from("automations").update(patch).eq("id", a.id);
    }
  }
}

// ---- Input validation (shared by the API routes) --------------------------

export type AutomationInput = {
  name: string;
  enabled: boolean;
  trigger_device_id: string;
  metric_key: string;
  operator: AutomationOperator;
  threshold: number;
  clear_threshold: number | null;
  action_device_id: string;
  action: IrCommand;
  cooldown_minutes: number;
  active_hours: ActiveHours;
};

type ValOk = { ok: true; value: AutomationInput };
type ValErr = { ok: false; error: string };

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function validateActiveHours(raw: unknown): { ok: true; value: ActiveHours } | ValErr {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (!isObj(raw)) return { ok: false, error: "active_hours must be an object or null" };
  const start = num(raw.start);
  const end = num(raw.end);
  const tz = num(raw.tz_offset_minutes) ?? 0;
  if (start === null || end === null || start < 0 || start > 23 || end < 0 || end > 23)
    return { ok: false, error: "active_hours.start/end must be 0..23" };
  return { ok: true, value: { start: Math.round(start), end: Math.round(end), tz_offset_minutes: Math.round(tz) } };
}

// Validate a full create/edit body (all fields required). The PATCH route does
// its own light partial handling for enabled/name. Returns the normalized input
// or an error string.
export function validateAutomationInput(raw: unknown): ValOk | ValErr {
  if (!isObj(raw)) return { ok: false, error: "body must be an object" };

  const name = typeof raw.name === "string" ? raw.name.trim().slice(0, 64) : "";
  if (!name) return { ok: false, error: "name is required" };

  if (typeof raw.trigger_device_id !== "string" || !raw.trigger_device_id)
    return { ok: false, error: "trigger_device_id is required" };
  if (typeof raw.action_device_id !== "string" || !raw.action_device_id)
    return { ok: false, error: "action_device_id is required" };
  if (typeof raw.metric_key !== "string" || !raw.metric_key)
    return { ok: false, error: "metric_key is required" };

  if (raw.operator !== "gt" && raw.operator !== "lt")
    return { ok: false, error: "operator must be 'gt' or 'lt'" };

  const threshold = num(raw.threshold);
  if (threshold === null) return { ok: false, error: "threshold must be a number" };

  let clear_threshold: number | null = null;
  if (raw.clear_threshold !== undefined && raw.clear_threshold !== null) {
    const c = num(raw.clear_threshold);
    if (c === null) return { ok: false, error: "clear_threshold must be a number or null" };
    // The deadband must sit on the in-band side of the threshold.
    if (raw.operator === "gt" && c > threshold)
      return { ok: false, error: "clear_threshold must be <= threshold for '>' rules" };
    if (raw.operator === "lt" && c < threshold)
      return { ok: false, error: "clear_threshold must be >= threshold for '<' rules" };
    clear_threshold = c;
  }

  const cmd = validateCommand(raw.action);
  if (!cmd.ok) return { ok: false, error: `action: ${cmd.error}` };

  let cooldown_minutes = 15;
  if (raw.cooldown_minutes !== undefined) {
    const cm = num(raw.cooldown_minutes);
    if (cm === null || cm < 0 || cm > 1440)
      return { ok: false, error: "cooldown_minutes must be 0..1440" };
    cooldown_minutes = Math.round(cm);
  }

  const ah = validateActiveHours(raw.active_hours);
  if (!ah.ok) return ah;

  return {
    ok: true,
    value: {
      name,
      enabled: raw.enabled === undefined ? true : !!raw.enabled,
      trigger_device_id: raw.trigger_device_id,
      metric_key: raw.metric_key.slice(0, 64),
      operator: raw.operator,
      threshold,
      clear_threshold,
      action_device_id: raw.action_device_id,
      action: cmd.command,
      cooldown_minutes,
      active_hours: ah.value,
    },
  };
}
