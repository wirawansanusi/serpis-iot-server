// Push-notification engine. Evaluated at ingest time, INDEPENDENTLY of the
// dashboard events engine (ingest_function.sql), against the per-device alert
// band in device_notification_settings. Goal: flag the important stuff without
// being annoying — so this is a debounced, rate-limited, quiet-hours-aware state
// machine, not a per-reading alarm. See supabase/migrate_notifications.sql.
import { supabase } from "@/lib/supabase";

export const HUMIDITY_KEY = "humidity";
export const CADENCES = ["balanced", "minimal", "max_safety"] as const;
export type Cadence = (typeof CADENCES)[number];

// How far past the band counts as "critical" — critical alerts skip the confirm
// window and punch through quiet hours so a genuinely bad reading is never held.
const CRITICAL_MARGIN = 10; // %RH past the threshold
// Readings older than this (vs wall clock) update state silently but never push,
// so a burst of backfilled readings after an outage can't spam old spikes. The
// latest (fresh) reading still drives a live alert if the condition persists.
const FRESHNESS_MS = 2 * 60 * 60 * 1000;
const QUIET_START_HOUR = 22;
const QUIET_END_HOUR = 8;

type CadenceParams = {
  confirmMs: number; // sustained out-of-range before the first alert
  cooldownMs: number; // min gap between pushes for the same condition
  quietHours: boolean; // hold non-critical alerts 22:00–08:00 local
  reminderMs: number[]; // re-alert offsets after the first alert
  reminderRepeat: boolean; // repeat the last offset until resolved
  dailyCap: number; // hard cap on pushes per device per day
  resolutionNotice: boolean; // send a "back to normal" when it clears
  deadband: number; // hysteresis margin (metric units) required to resolve
};

// The three user-selectable presets. Tune freely — the app only sends the name.
const CADENCE: Record<Cadence, CadenceParams> = {
  // Flag it, then get out of the way; nights stay quiet unless it's critical.
  balanced: {
    confirmMs: 10 * 60 * 1000,
    cooldownMs: 60 * 60 * 1000,
    quietHours: true,
    reminderMs: [6 * 60 * 60 * 1000, 12 * 60 * 60 * 1000],
    reminderRepeat: true,
    dailyCap: 6,
    resolutionNotice: false,
    deadband: 2,
  },
  // One alert per event, full stop. Fewest interruptions.
  minimal: {
    confirmMs: 10 * 60 * 1000,
    cooldownMs: 60 * 60 * 1000,
    quietHours: false,
    reminderMs: [],
    reminderRepeat: false,
    dailyCap: 4,
    resolutionNotice: false,
    deadband: 2,
  },
  // Never miss anything: immediate, no quiet hours, nags until resolved.
  max_safety: {
    confirmMs: 0,
    cooldownMs: 30 * 60 * 1000,
    quietHours: false,
    reminderMs: [30 * 60 * 1000],
    reminderRepeat: true,
    dailyCap: 24,
    resolutionNotice: true,
    deadband: 1,
  },
};

type Settings = {
  device_id: string;
  enabled: boolean;
  use_profile: boolean;
  alert_low: number | null;
  alert_high: number | null;
  cadence: Cadence;
  tz_offset_minutes: number;
};

type AlertState = {
  device_id: string;
  metric_key: string;
  state: "normal" | "pending" | "active";
  direction: "high" | "low" | null;
  since_at: string | null;
  last_notified_at: string | null;
  reminder_count: number;
  deferred: boolean;
  notified_day: string | null;
  notified_count: number;
  last_value: number | null;
};

type PushMessage = { title: string; body: string; data: Record<string, unknown> };

function isQuietHours(atMs: number, tzOffsetMinutes: number): boolean {
  const localHour = Math.floor(((atMs / 3_600_000 + tzOffsetMinutes / 60) % 24 + 24) % 24);
  return localHour >= QUIET_START_HOUR || localHour < QUIET_END_HOUR;
}

function dayKey(atMs: number, tzOffsetMinutes: number): string {
  return new Date(atMs + tzOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

// Next re-alert offset given how many reminders we've already sent.
function nextReminderMs(p: CadenceParams, reminderCount: number): number | null {
  if (reminderCount < p.reminderMs.length) return p.reminderMs[reminderCount];
  if (p.reminderRepeat && p.reminderMs.length > 0) return p.reminderMs[p.reminderMs.length - 1];
  return null;
}

function defaultState(deviceId: string, metricKey: string): AlertState {
  return {
    device_id: deviceId,
    metric_key: metricKey,
    state: "normal",
    direction: null,
    since_at: null,
    last_notified_at: null,
    reminder_count: 0,
    deferred: false,
    notified_day: null,
    notified_count: 0,
    last_value: null,
  };
}

function humanSince(sinceMs: number, nowMs: number): string {
  const mins = Math.max(1, Math.round((nowMs - sinceMs) / 60_000));
  if (mins < 60) return `${mins} min`;
  const hours = Math.round(mins / 60);
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

// Evaluate one humidity reading and push if the cadence policy says so. Safe to
// call on every claimed ingest; it no-ops unless notifications are enabled.
export async function evaluateHumidityAlert(opts: {
  deviceId: string;
  ownerUserId: string | null;
  deviceName: string | null;
  value: number;
  recordedAtMs: number;
}): Promise<void> {
  const { deviceId, ownerUserId, deviceName, value, recordedAtMs } = opts;

  const { data: settingsRow } = await supabase
    .from("device_notification_settings")
    .select("device_id, enabled, use_profile, alert_low, alert_high, cadence, tz_offset_minutes")
    .eq("device_id", deviceId)
    .maybeSingle();
  const settings = settingsRow as Settings | null;
  if (!settings || !settings.enabled) return;

  const low = settings.alert_low;
  const high = settings.alert_high;
  if (low === null && high === null) return;

  const p = CADENCE[settings.cadence] ?? CADENCE.balanced;
  const now = recordedAtMs;
  const fresh = Date.now() - recordedAtMs < FRESHNESS_MS;

  const { data: stateRow } = await supabase
    .from("device_alert_state")
    .select("*")
    .eq("device_id", deviceId)
    .eq("metric_key", HUMIDITY_KEY)
    .maybeSingle();
  const s: AlertState = (stateRow as AlertState | null) ?? defaultState(deviceId, HUMIDITY_KEY);

  const breach: "high" | "low" | null =
    high !== null && value > high ? "high" : low !== null && value < low ? "low" : null;
  const critical =
    breach === "high" && high !== null && value >= high + CRITICAL_MARGIN
      ? true
      : breach === "low" && low !== null && value <= low - CRITICAL_MARGIN;

  let message: PushMessage | null = null;

  // --- Daily cap bookkeeping (per local day) ---
  const today = dayKey(now, settings.tz_offset_minutes);
  if (s.notified_day !== today) {
    s.notified_day = today;
    s.notified_count = 0;
  }
  const capOk = s.notified_count < p.dailyCap;
  const quietOk = !p.quietHours || critical || !isQuietHours(now, settings.tz_offset_minutes);

  const markSent = () => {
    s.last_notified_at = new Date(now).toISOString();
    s.notified_count += 1;
    s.deferred = false;
  };

  if (breach) {
    // Side flip (e.g. was high, now low) restarts the confirm window.
    if (s.state !== "normal" && s.direction && s.direction !== breach) {
      s.state = "pending";
      s.direction = breach;
      s.since_at = new Date(now).toISOString();
      s.reminder_count = 0;
      s.deferred = false;
      s.last_notified_at = null;
    }

    if (s.state === "active" && s.direction === breach) {
      // Already alerted. Either release a quiet-hours-deferred alert, or remind.
      const lastMs = s.last_notified_at ? Date.parse(s.last_notified_at) : 0;
      if (s.deferred && quietOk && capOk && fresh) {
        message = buildAlert(deviceName, breach, value, low, high, critical);
        markSent();
      } else {
        const offset = nextReminderMs(p, s.reminder_count);
        if (offset !== null && lastMs > 0 && now - lastMs >= offset && quietOk && capOk && fresh) {
          message = buildReminder(deviceName, breach, value, s.since_at, now);
          s.reminder_count += 1;
          markSent();
        }
      }
    } else {
      // normal/pending -> establish/continue pending, then confirm.
      if (s.state !== "pending" || s.direction !== breach) {
        s.state = "pending";
        s.direction = breach;
        s.since_at = new Date(now).toISOString();
        s.reminder_count = 0;
        s.deferred = false;
        s.last_notified_at = null;
      }
      const sinceMs = s.since_at ? Date.parse(s.since_at) : now;
      const confirmed = critical || now - sinceMs >= p.confirmMs;
      const lastMs = s.last_notified_at ? Date.parse(s.last_notified_at) : 0;
      const cooldownOk = lastMs === 0 || now - lastMs >= p.cooldownMs;
      if (confirmed && cooldownOk) {
        s.state = "active";
        if (!fresh) {
          // Stale backfill: record the condition but don't push about the past.
        } else if (quietOk && capOk) {
          message = buildAlert(deviceName, breach, value, low, high, critical);
          markSent();
        } else if (!quietOk && capOk) {
          s.deferred = true; // held until quiet hours end (released above)
        }
      }
    }
  } else {
    // In band. Resolve only past the hysteresis deadband so it can't flap.
    const resolved =
      s.direction === "high"
        ? high === null || value <= high - p.deadband
        : s.direction === "low"
          ? low === null || value >= low + p.deadband
          : true;
    if (s.state !== "normal" && resolved) {
      if (s.state === "active" && s.last_notified_at && p.resolutionNotice && fresh && quietOk && capOk) {
        message = {
          title: `${deviceName ?? "Humid sensor"}: back to normal`,
          body: `Humidity is back in range at ${Math.round(value)}%.`,
          data: { deviceId, metric: HUMIDITY_KEY, kind: "resolved" },
        };
        markSent();
      }
      s.state = "normal";
      s.direction = null;
      s.since_at = null;
      s.last_notified_at = null;
      s.reminder_count = 0;
      s.deferred = false;
    }
  }

  s.last_value = value;
  await supabase.from("device_alert_state").upsert(
    {
      device_id: s.device_id,
      metric_key: s.metric_key,
      state: s.state,
      direction: s.direction,
      since_at: s.since_at,
      last_notified_at: s.last_notified_at,
      reminder_count: s.reminder_count,
      deferred: s.deferred,
      notified_day: s.notified_day,
      notified_count: s.notified_count,
      last_value: s.last_value,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "device_id,metric_key" },
  );

  if (message && ownerUserId) {
    const tokens = await ownerTokens(ownerUserId);
    await sendExpoPush(tokens, message);
  }
}

function buildAlert(
  deviceName: string | null,
  dir: "high" | "low",
  value: number,
  low: number | null,
  high: number | null,
  critical: boolean,
): PushMessage {
  const name = deviceName ?? "Humid sensor";
  const threshold = dir === "high" ? `above ${Math.round(high ?? 0)}%` : `below ${Math.round(low ?? 0)}%`;
  return {
    title: `${critical ? "⚠️ " : ""}${name}: humidity ${dir}`,
    body: `Now ${Math.round(value)}% RH — ${threshold}.`,
    data: { metric: HUMIDITY_KEY, kind: "alert", direction: dir, critical },
  };
}

function buildReminder(
  deviceName: string | null,
  dir: "high" | "low",
  value: number,
  sinceIso: string | null,
  nowMs: number,
): PushMessage {
  const name = deviceName ?? "Humid sensor";
  const since = sinceIso ? humanSince(Date.parse(sinceIso), nowMs) : "a while";
  return {
    title: `${name}: still ${dir}`,
    body: `Humidity still ${dir} at ${Math.round(value)}% after ${since}.`,
    data: { metric: HUMIDITY_KEY, kind: "reminder", direction: dir },
  };
}

async function ownerTokens(userId: string): Promise<string[]> {
  const { data } = await supabase.from("push_tokens").select("token").eq("user_id", userId);
  return ((data ?? []) as { token: string }[]).map((r) => r.token);
}

// Send via the Expo push service directly (no SDK dependency). Degrades to a
// no-op when there are no tokens; prunes tokens Expo reports as unregistered.
async function sendExpoPush(tokens: string[], msg: PushMessage): Promise<void> {
  if (tokens.length === 0) return;
  const messages = tokens.map((to) => ({
    to,
    title: msg.title,
    body: msg.body,
    sound: "default",
    priority: "high",
    channelId: "alerts",
    data: msg.data,
  }));
  try {
    const res = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(messages),
    });
    const json = (await res.json()) as { data?: { status?: string; details?: { error?: string } }[] };
    const tickets = json?.data;
    if (Array.isArray(tickets)) {
      for (let i = 0; i < tickets.length; i++) {
        if (tickets[i]?.status === "error" && tickets[i]?.details?.error === "DeviceNotRegistered") {
          await supabase.from("push_tokens").delete().eq("token", tokens[i]);
        }
      }
    }
  } catch (e) {
    console.error("[notifications] expo push failed", e);
  }
}
