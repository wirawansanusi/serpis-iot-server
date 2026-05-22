-- Run once in the Supabase SQL editor on a fresh project.
-- Enable pg_cron in Dashboard > Database > Extensions before running cron.sql.

create extension if not exists pgcrypto;

create table if not exists devices (
  id              uuid primary key default gen_random_uuid(),
  mac             text unique not null,
  name            text,
  -- Clerk user id (e.g. "user_2NN...") of the account that owns this device.
  -- Filled by /dashboard/claim. Stays NULL until claimed.
  owner_user_id   text,
  humidity_min    real not null default 30,
  humidity_max    real not null default 65,
  temp_min        real not null default 10,
  temp_max        real not null default 35,
  first_seen      timestamptz not null default now(),
  last_seen       timestamptz not null default now()
);
create index if not exists devices_owner_idx on devices(owner_user_id);

create table if not exists readings (
  id          bigserial primary key,
  device_id   uuid not null references devices(id) on delete cascade,
  temp_c      real not null,
  humidity    real not null,
  uptime_ms   bigint,
  recorded_at timestamptz not null default now()
);
create index if not exists readings_device_time_idx
  on readings (device_id, recorded_at desc);

create table if not exists readings_hourly (
  device_id    uuid not null references devices(id) on delete cascade,
  hour         timestamptz not null,
  temp_min     real not null,
  temp_max     real not null,
  temp_avg     real not null,
  hum_min      real not null,
  hum_max      real not null,
  hum_avg      real not null,
  sample_count int  not null,
  primary key (device_id, hour)
);

create table if not exists readings_daily (
  device_id            uuid not null references devices(id) on delete cascade,
  day                  date not null,
  temp_min             real not null,
  temp_max             real not null,
  temp_avg             real not null,
  hum_min              real not null,
  hum_max              real not null,
  hum_avg              real not null,
  sample_count         int  not null,
  abnormal_event_count int  not null default 0,
  primary key (device_id, day)
);

create table if not exists events (
  id            bigserial primary key,
  device_id     uuid not null references devices(id) on delete cascade,
  kind          text not null check (kind in ('humidity_high','humidity_low','temp_high','temp_low')),
  started_at    timestamptz not null default now(),
  ended_at      timestamptz,
  peak_value    real not null,
  trigger_value real not null,
  threshold     real not null
);
create index if not exists events_device_started_idx on events(device_id, started_at desc);
create unique index if not exists events_one_open_per_kind
  on events(device_id, kind) where ended_at is null;
