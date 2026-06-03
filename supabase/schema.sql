-- Run once in the Supabase SQL editor on a fresh project.
-- Apply order: schema.sql, seed.sql, ingest_function.sql, grants.sql, then cron.sql.
-- Migrating an existing (temp/humidity) project? Run reset.sql FIRST to drop the
-- old model (destructive — clean slate, no data migration), then this order.
-- Enable pg_cron in Dashboard > Database > Extensions before running cron.sql.
--
-- Multi-sensor IoT model. A device reports an arbitrary set of *metrics*
-- (temp_c, humidity, co2, pm25, door_state, ...). Metrics are self-describing:
-- the first time a device sends a metric key, ingest auto-registers it in the
-- `metrics` registry (see ingest_function.sql), which holds the display + viz
-- config that drives the dashboard. No code change is needed for a new sensor.

create extension if not exists pgcrypto;

-- Registry of metric definitions, shared across all devices. Auto-seeded on
-- first sight by ingest_reading(); editable afterwards. `color` is either a
-- literal hex (#rrggbb) or one of the theme tokens accent|bad|good|warn, which
-- the frontend resolves to a CSS variable so it adapts to light/dark mode.
create table if not exists metrics (
  key         text primary key,
  label       text not null,
  unit        text not null default '',
  precision   int  not null default 1,
  chart_type  text not null default 'line'
                check (chart_type in ('line','area','gauge','bar','state')),
  axis        text not null default 'left' check (axis in ('left','right')),
  color       text,
  default_min real,
  default_max real,
  sort_order  int  not null default 100,
  created_at  timestamptz not null default now()
);

create table if not exists devices (
  id                uuid primary key default gen_random_uuid(),
  -- Stable external identity (random UUID), injected at provisioning. Safe to
  -- put in BLE adverts, URLs, and logs. This is what ingest + claim key on.
  public_device_id  text unique not null,
  -- Wi-Fi MAC, diagnostic metadata only (no longer the device key).
  mac               text,
  name              text,
  -- Free-text type the device self-reports (e.g. 'humid-sht31', 'air-quality').
  device_type       text,
  -- Clerk user id (e.g. "user_2NN...") of the owner. NULL until claimed.
  owner_user_id     text,
  -- AES-256-GCM(claim_secret), base64. Injected at provisioning; never exposed.
  claim_secret_enc  text,
  claim_state       text not null default 'unclaimed'
                      check (claim_state in ('unclaimed','claim_pending','claimed','disabled')),
  claimed_at        timestamptz,
  firmware_version  text,
  -- Latest battery status (device status, not a charted metric). power_source is
  -- 'battery' or 'external'; battery_percent is null while on external power.
  battery_percent   int,
  battery_mv        int,
  power_source      text,
  first_seen        timestamptz not null default now(),
  last_seen         timestamptz not null default now(),
  -- Set when ownership is removed; on the next ingest the server tells the
  -- device to wipe its stored Wi-Fi credentials, so a handed-over sensor lands
  -- in BLE provisioning mode for its next owner instead of reusing the old
  -- WiFi. Cleared after the response is sent (best-effort, single delivery).
  wipe_credentials_pending boolean not null default false,
  -- How often the device powers up Wi-Fi to upload, in minutes. The device
  -- always *samples* every 5 min; this only batches uploads to save battery.
  -- Owner-set from the app, echoed to the device in each ingest response.
  report_interval_minutes int not null default 5
                      check (report_interval_minutes in (5,10,15,30,60))
);
create index if not exists devices_owner_idx on devices(owner_user_id);

-- Short-lived server challenges for the BLE claim challenge-response. A row is
-- created by /api/devices/claim/start and consumed by /complete.
create table if not exists device_claim_challenges (
  id                uuid primary key default gen_random_uuid(),
  public_device_id  text not null references devices(public_device_id) on delete cascade,
  user_id           text not null,
  server_challenge  text not null,
  expires_at        timestamptz not null,
  used_at           timestamptz,
  created_at        timestamptz not null default now()
);
create index if not exists claim_challenges_lookup_idx
  on device_claim_challenges (public_device_id, server_challenge);
create index if not exists claim_challenges_expiry_idx
  on device_claim_challenges (expires_at);

-- Per-device alert bounds, one row per metric the device reports. A row also
-- doubles as the record of "this device reports this metric", so the dashboard
-- reads a device's metric inventory from here (joined to `metrics`). Bounds are
-- nullable: a null side means no alerting on that side.
create table if not exists device_metric_thresholds (
  device_id   uuid not null references devices(id) on delete cascade,
  metric_key  text not null references metrics(key),
  min_val     real,
  max_val     real,
  -- Named preset this band came from (humidity only today): the app's profile id
  -- ('electronics','comfort','instruments','wine') or 'custom'. NULL = unset; the
  -- band stays authoritative regardless. Validated in the humidity-profile route.
  profile_id  text,
  primary key (device_id, metric_key)
);

-- Long/narrow time series: one row per metric per sample.
create table if not exists readings (
  id          bigserial primary key,
  device_id   uuid not null references devices(id) on delete cascade,
  metric_key  text not null references metrics(key),
  value       real not null,
  recorded_at timestamptz not null default now()
);
create index if not exists readings_device_metric_time_idx
  on readings (device_id, metric_key, recorded_at desc);

create table if not exists readings_hourly (
  device_id    uuid not null references devices(id) on delete cascade,
  metric_key   text not null references metrics(key),
  hour         timestamptz not null,
  val_min      real not null,
  val_max      real not null,
  val_avg      real not null,
  sample_count int  not null,
  primary key (device_id, metric_key, hour)
);

create table if not exists readings_daily (
  device_id            uuid not null references devices(id) on delete cascade,
  metric_key           text not null references metrics(key),
  day                  date not null,
  val_min              real not null,
  val_max              real not null,
  val_avg              real not null,
  sample_count         int  not null,
  abnormal_event_count int  not null default 0,
  primary key (device_id, metric_key, day)
);

-- Abnormal-condition events, generalized over any metric and direction.
create table if not exists events (
  id            bigserial primary key,
  device_id     uuid not null references devices(id) on delete cascade,
  metric_key    text not null references metrics(key),
  direction     text not null check (direction in ('high','low')),
  started_at    timestamptz not null default now(),
  ended_at      timestamptz,
  peak_value    real not null,
  trigger_value real not null,
  threshold     real not null
);
create index if not exists events_device_started_idx on events(device_id, started_at desc);
create unique index if not exists events_one_open_per_metric_dir
  on events(device_id, metric_key, direction) where ended_at is null;

-- Push notifications. Alerts are evaluated independently of the events engine
-- above, against a per-device alert band (default = humidity profile snapshot).
-- See supabase/migrate_notifications.sql for the full rationale + lib/notifications.ts.
create table if not exists push_tokens (
  token         text primary key,
  user_id       text not null,
  platform      text,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);
create index if not exists push_tokens_user_idx on push_tokens(user_id);

create table if not exists device_notification_settings (
  device_id     uuid primary key references devices(id) on delete cascade,
  use_profile   boolean not null default true,
  alert_low     real,
  alert_high    real,
  cadence       text not null default 'balanced'
                  check (cadence in ('balanced','minimal','max_safety')),
  tz_offset_minutes int not null default 0,
  updated_at    timestamptz not null default now()
);

-- Per-phone delivery. A row = "this install (push token) wants alerts for this
-- sensor." The band/cadence above (device_notification_settings) is the shared
-- *definition* of when a sensor is out of range; this table is the per-phone
-- *delivery list* the engine fans out to. Absence of a row = off for that phone.
-- Cascades clean themselves up: removing a sensor or unregistering a token
-- (sign-out) drops the matching subscriptions. The engine additionally filters
-- by the device owner's user_id so a re-owned phone never gets stale alerts.
create table if not exists device_push_subscriptions (
  device_id   uuid not null references devices(id) on delete cascade,
  token       text not null references push_tokens(token) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (device_id, token)
);
create index if not exists device_push_subscriptions_token_idx on device_push_subscriptions(token);

create table if not exists device_alert_state (
  device_id        uuid not null references devices(id) on delete cascade,
  metric_key       text not null references metrics(key),
  state            text not null default 'normal'
                     check (state in ('normal','pending','active')),
  direction        text check (direction in ('high','low')),
  since_at         timestamptz,
  last_notified_at timestamptz,
  reminder_count   int not null default 0,
  deferred         boolean not null default false,
  notified_day     date,
  notified_count   int not null default 0,
  last_value       real,
  updated_at       timestamptz not null default now(),
  primary key (device_id, metric_key)
);

-- OTA firmware releases. One row per (device_type, version) artifact, whose
-- bytes live in object storage (Tencent COS) under `cos_key`. A release is
-- immutable once `enabled` (enforced in app code). `min/max_current_version`
-- bound which running versions the release applies to (inclusive, semver;
-- null = unbounded).
create table if not exists firmware_releases (
  id                  uuid primary key default gen_random_uuid(),
  device_type         text not null,
  version             text not null,
  cos_key             text not null,
  sha256              text not null check (char_length(sha256) = 64),
  size_bytes          bigint not null check (size_bytes > 0),
  release_notes       text,
  min_current_version text,
  max_current_version text,
  enabled             boolean not null default false,
  mandatory           boolean not null default false,
  created_at          timestamptz not null default now(),
  created_by          text,
  unique (device_type, version)
);
create index if not exists firmware_releases_type_enabled_idx
  on firmware_releases (device_type, enabled);

-- Per-device OTA state machine + last reported status (one row per device).
-- The offer is computed at ingest time from firmware_releases + this row:
--   * update_requested_version: the version the user opted into (Start update);
--     optional releases are only offered when this matches.
--   * failed_version: blocks re-offering that version until Retry clears it.
--   * offered_at: when an offer was last returned (drives the "installing"
--     staleness timeout in the UI).
-- Updates can't be dismissed by the user — the notification persists until they
-- actually update.
create table if not exists device_ota (
  device_id                uuid primary key references devices(id) on delete cascade,
  target_version           text,
  ota_state                text not null default 'idle'
                             check (ota_state in ('idle','available','offered','downloading',
                                                  'deferred','failed','installed','rolled_back')),
  update_requested_version text,
  failed_version           text,
  offered_at               timestamptz,
  last_status              text,
  last_error_code          int,
  last_message             text,
  last_at                  timestamptz,
  updated_at               timestamptz not null default now()
);
