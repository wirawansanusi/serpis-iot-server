-- Per-phone notification delivery.
--
-- Background: alerts were account-wide. device_notification_settings holds the
-- shared alert *definition* (band + cadence + tz), and the engine fanned out to
-- EVERY push token the owner had (lib/notifications.ts ownerTokens). So toggling
-- a sensor's alerts on one phone affected every phone on the account.
--
-- This splits *delivery* from *definition*: each install (push token) subscribes
-- to the sensors it wants. The band/cadence stay shared; only who-gets-pinged is
-- per-phone. A user can now have their work phone alerting on warehouse sensors
-- and their personal phone on the bedroom one. Idempotent.

-- A row = "this push token wants alerts for this device." Absence = off.
-- on delete cascade (push_tokens): sign-out / DeviceNotRegistered pruning drops
--   the token, which drops its subscriptions.
-- on delete cascade (devices): removing a sensor drops its subscriptions.
create table if not exists device_push_subscriptions (
  device_id   uuid not null references devices(id) on delete cascade,
  token       text not null references push_tokens(token) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (device_id, token)
);

-- Reverse lookup: "which sensors does this phone subscribe to" + token cascades.
create index if not exists device_push_subscriptions_token_idx on device_push_subscriptions(token);

-- Drop the now-dead device_notification_settings.enabled column. On/off is per
-- phone (a device_push_subscriptions row), which a single sensor-level boolean
-- can't represent — so the old column just sat stuck at true and contradicted the
-- app's Alerts toggle. The engine gates on subscriptions; the dashboard derives
-- `enabled` per-phone; nothing reads this column anymore. Safe to drop.
alter table device_notification_settings drop column if exists enabled;
