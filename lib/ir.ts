// The IR "command contract": the JSON shapes shared byte-for-byte between the
// backend (this file builds/validates them), the firmware (src/ir_command.cpp
// dispatches on `kind`), and the app (lib/ir.ts mirrors these types).
//
// A command is published to serpis/ir/<public_device_id>/cmd over MQTT.

export type AcMode = "cool" | "heat" | "dry" | "fan" | "auto";
export type AcFan = "auto" | "min" | "low" | "medium" | "high" | "max";
export type AcSwing = "off" | "on" | "auto";

export type AcState = {
  power?: boolean;
  mode?: AcMode;
  temp?: number;       // target temperature
  celsius?: boolean;   // default true
  fan?: AcFan;
  swing?: AcSwing;
};

export type IrCommand =
  | { id?: string; kind: "protocol"; protocol: string; code: string; bits?: number; repeats?: number }
  | { id?: string; kind: "ac"; vendor: string; state: AcState }
  | { id?: string; kind: "raw"; carrier_hz?: number; timings_us: number[] }
  | { id?: string; kind: "learn"; timeout_s?: number }
  | { id?: string; kind: "macro"; steps: MacroStep[] };

export type MacroStep = IrCommand | { delay_ms: number };

const AC_MODES: AcMode[] = ["cool", "heat", "dry", "fan", "auto"];
const AC_FANS: AcFan[] = ["auto", "min", "low", "medium", "high", "max"];
const AC_SWINGS: AcSwing[] = ["off", "on", "auto"];
const MAX_RAW_TIMINGS = 1024;
const MAX_MACRO_STEPS = 20;

type Ok = { ok: true; command: IrCommand };
type Err = { ok: false; error: string };

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function isFiniteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function validateAcState(raw: unknown): { ok: true; state: AcState } | Err {
  if (!isObj(raw)) return { ok: false, error: "ac.state must be an object" };
  const s: AcState = {};
  if (raw.power !== undefined) {
    if (typeof raw.power !== "boolean") return { ok: false, error: "ac.state.power must be boolean" };
    s.power = raw.power;
  }
  if (raw.mode !== undefined) {
    if (typeof raw.mode !== "string" || !AC_MODES.includes(raw.mode as AcMode))
      return { ok: false, error: `ac.state.mode must be one of ${AC_MODES.join(", ")}` };
    s.mode = raw.mode as AcMode;
  }
  if (raw.temp !== undefined) {
    if (!isFiniteNum(raw.temp) || raw.temp < 16 || raw.temp > 32)
      return { ok: false, error: "ac.state.temp must be 16..32" };
    s.temp = Math.round(raw.temp);
  }
  if (raw.celsius !== undefined) {
    if (typeof raw.celsius !== "boolean") return { ok: false, error: "ac.state.celsius must be boolean" };
    s.celsius = raw.celsius;
  }
  if (raw.fan !== undefined) {
    if (typeof raw.fan !== "string" || !AC_FANS.includes(raw.fan as AcFan))
      return { ok: false, error: `ac.state.fan must be one of ${AC_FANS.join(", ")}` };
    s.fan = raw.fan as AcFan;
  }
  if (raw.swing !== undefined) {
    if (typeof raw.swing !== "string" || !AC_SWINGS.includes(raw.swing as AcSwing))
      return { ok: false, error: `ac.state.swing must be one of ${AC_SWINGS.join(", ")}` };
    s.swing = raw.swing as AcSwing;
  }
  return { ok: true, state: s };
}

// Validate a single command (optionally allowing nested commands as macro
// steps). Normalizes `code` to a string so the firmware parses it uniformly.
function validateOne(raw: unknown, allowMacro: boolean): Ok | Err {
  if (!isObj(raw)) return { ok: false, error: "command must be an object" };
  const kind = raw.kind;
  if (typeof kind !== "string") return { ok: false, error: "command.kind is required" };

  switch (kind) {
    case "protocol": {
      if (typeof raw.protocol !== "string" || raw.protocol.length === 0)
        return { ok: false, error: "protocol.protocol is required" };
      let code: string;
      if (typeof raw.code === "string") code = raw.code;
      else if (isFiniteNum(raw.code)) code = String(raw.code);
      else return { ok: false, error: "protocol.code must be a hex string or number" };
      const bits = raw.bits === undefined ? undefined : Number(raw.bits);
      if (bits !== undefined && (!Number.isInteger(bits) || bits < 0 || bits > 64))
        return { ok: false, error: "protocol.bits must be 0..64" };
      const repeats = raw.repeats === undefined ? undefined : Number(raw.repeats);
      if (repeats !== undefined && (!Number.isInteger(repeats) || repeats < 0 || repeats > 20))
        return { ok: false, error: "protocol.repeats must be 0..20" };
      return { ok: true, command: { kind: "protocol", protocol: raw.protocol, code, bits, repeats } };
    }
    case "ac": {
      if (typeof raw.vendor !== "string" || raw.vendor.length === 0)
        return { ok: false, error: "ac.vendor is required" };
      const st = validateAcState(raw.state);
      if (!st.ok) return st;
      return { ok: true, command: { kind: "ac", vendor: raw.vendor, state: st.state } };
    }
    case "raw": {
      if (!Array.isArray(raw.timings_us) || raw.timings_us.length < 2)
        return { ok: false, error: "raw.timings_us must be an array of >=2 durations" };
      if (raw.timings_us.length > MAX_RAW_TIMINGS)
        return { ok: false, error: `raw.timings_us too long (max ${MAX_RAW_TIMINGS})` };
      const timings: number[] = [];
      for (const t of raw.timings_us) {
        if (!isFiniteNum(t) || t <= 0 || t > 70000)
          return { ok: false, error: "raw.timings_us entries must be 1..70000 µs" };
        timings.push(Math.round(t));
      }
      let carrier_hz: number | undefined;
      if (raw.carrier_hz !== undefined) {
        if (!isFiniteNum(raw.carrier_hz) || raw.carrier_hz < 30000 || raw.carrier_hz > 60000)
          return { ok: false, error: "raw.carrier_hz must be 30000..60000" };
        carrier_hz = Math.round(raw.carrier_hz);
      }
      return { ok: true, command: { kind: "raw", carrier_hz, timings_us: timings } };
    }
    case "learn": {
      let timeout_s: number | undefined;
      if (raw.timeout_s !== undefined) {
        if (!isFiniteNum(raw.timeout_s) || raw.timeout_s < 5 || raw.timeout_s > 60)
          return { ok: false, error: "learn.timeout_s must be 5..60" };
        timeout_s = Math.round(raw.timeout_s);
      }
      return { ok: true, command: { kind: "learn", timeout_s } };
    }
    case "macro": {
      if (!allowMacro) return { ok: false, error: "nested macros are not allowed" };
      if (!Array.isArray(raw.steps) || raw.steps.length === 0)
        return { ok: false, error: "macro.steps must be a non-empty array" };
      if (raw.steps.length > MAX_MACRO_STEPS)
        return { ok: false, error: `macro.steps too long (max ${MAX_MACRO_STEPS})` };
      const steps: MacroStep[] = [];
      for (const step of raw.steps) {
        if (isObj(step) && step.delay_ms !== undefined) {
          if (!isFiniteNum(step.delay_ms) || step.delay_ms < 0 || step.delay_ms > 10000)
            return { ok: false, error: "macro delay_ms must be 0..10000" };
          steps.push({ delay_ms: Math.round(step.delay_ms) });
          continue;
        }
        const inner = validateOne(step, false);
        if (!inner.ok) return { ok: false, error: `macro step: ${inner.error}` };
        steps.push(inner.command);
      }
      return { ok: true, command: { kind: "macro", steps } };
    }
    default:
      return { ok: false, error: `unknown command kind: ${kind}` };
  }
}

// Public entry: validate a top-level command from an API request body.
export function validateCommand(raw: unknown): Ok | Err {
  return validateOne(raw, true);
}
