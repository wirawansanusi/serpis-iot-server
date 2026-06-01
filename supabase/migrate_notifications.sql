-- Push notifications for out-of-range humidity (and future metrics).
--
-- Design: alerts are evaluated INDEPENDENTLY of the dashboard's events engine
-- (ingest_function.sql), against a per-device alert band stored here. The band
-- defaults to a snapshot of the app's humidity profile (use_profile = true) but
-- does not auto-follow later profile edits — the app re-syncs it on change. The
-- cadence (how often we actually push) is a user-chosen preset. Idempotent.

-- Expo push tokens, one row per installed app instance, owned by a Clerk user.
-- A user can have several (phone + tablet). DeviceNotRegistered tickets prune
-- stale rows (handled in lib/notifications.ts).
create table if not exists push_tokens (
  token         text primary key,                 -- ExponentPushToken[...]
  user_id       text not null,                    -- Clerk user id
  platform      text,                             -- 'ios' | 'android' | null
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);
create index if not exists push_tokens_user_idx on push_tokens(user_id);

-- Per-device notification preferences (owner-set from the app).
create table if not exists device_notification_settings (
  device_id     uuid primary key references devices(id) on delete cascade,
  enabled       boolean not null default false,
  -- true => alert band tracks a snapshot of the humidity profile; false => the
  -- user typed custom alert_low/alert_high. Either way the values live below.
  use_profile   boolean not null default true,
  alert_low     real,                             -- push when humidity < this
  alert_high    real,                             -- push when humidity > this
  cadence       text not null default 'balanced'
                  check (cadence in ('balanced','minimal','max_safety')),
  -- Minutes east of UTC, sent by the app, so quiet hours land in local time.
  tz_offset_minutes int not null default 0,
  updated_at    timestamptz not null default now()
);

-- Per-device, per-metric alert state machine. One condition can be active per
-- metric at a time (humidity can't be simultaneously high and low), so the key
-- is (device, metric) and `direction` records which side is currently breached.
create table if not exists device_alert_state (
  device_id       uuid not null references devices(id) on delete cascade,
  metric_key      text not null references metrics(key),
  -- 'normal'  : in band
  -- 'pending' : out of band, waiting out the confirm window
  -- 'active'  : alerted, condition ongoing
  state           text not null default 'normal'
                    check (state in ('normal','pending','active')),
  direction       text check (direction in ('high','low')),
  since_at        timestamptz,                    -- when the current breach began
  last_notified_at timestamptz,                   -- last push for this condition
  reminder_count  int not null default 0,         -- escalating re-alerts sent
  deferred        boolean not null default false, -- held by quiet hours, owed on release
  notified_day    date,                           -- for the daily cap
  notified_count  int not null default 0,         -- pushes sent on notified_day
  last_value      real,
  updated_at      timestamptz not null default now(),
  primary key (device_id, metric_key)
);
