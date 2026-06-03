-- Promote the humidity "profile" from a phone-local setting to a per-sensor,
-- server-owned property. The band (min_val/max_val) already lived here and drives
-- the events engine; this adds the *named* preset the user picked so every phone
-- shows the same profile and the band stays in lockstep across devices.
--
-- profile_id is the app's preset id ('electronics', 'comfort', 'instruments',
-- 'wine') or 'custom'; NULL means legacy/unset (the band is still authoritative).
-- Not constrained here on purpose — the allowed set is validated in the endpoint
-- (app/api/devices/[id]/humidity-profile/route.ts) and can evolve without a
-- migration. Generic per-metric column; only the humidity row uses it today.
-- Idempotent.

alter table device_metric_thresholds
  add column if not exists profile_id text;
