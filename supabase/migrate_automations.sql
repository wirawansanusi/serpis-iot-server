-- If-then automations: a sensor reading crossing a threshold fires an IR action.
--
-- This is the cross-device payoff of having sensors + actuators on one platform:
--   IF [trigger device]'s [metric] [> | <] [threshold]  THEN  fire [IR command]
--   on [action device] (an ir-blaster).
--
-- Evaluated at ingest time in lib/automations.ts, AFTER the reading lands (the
-- same place push alerts run). Anti-flap is built in: a rising-edge latch
-- (is_active), a per-rule cooldown, a hysteresis deadband (clear_threshold), and
-- optional active hours. Both the trigger and action devices must belong to the
-- owner (enforced in the API + re-checked at fire time).
--
-- Apply after schema.sql + migrate_ir.sql. Idempotent.

create table if not exists automations (
  id                uuid primary key default gen_random_uuid(),
  owner_user_id     text not null,                       -- Clerk user id (== both devices' owner)
  name              text not null,
  enabled           boolean not null default true,

  -- IF: a metric on the trigger device crosses the threshold.
  trigger_device_id uuid not null references devices(id) on delete cascade,
  metric_key        text not null,                       -- e.g. 'humidity', 'temperature'
  operator          text not null check (operator in ('gt','lt')),
  threshold         real not null,
  -- Hysteresis: the rule only re-arms once the value passes back through this
  -- (gt rules: value <= clear; lt rules: value >= clear). NULL => re-arm as soon
  -- as the value is no longer breaching.
  clear_threshold   real,

  -- THEN: fire this command-contract object on the action device (an ir-blaster).
  action_device_id  uuid not null references devices(id) on delete cascade,
  action            jsonb not null,                      -- {kind:protocol|ac|raw|macro, ...}

  -- Anti-flap controls.
  cooldown_minutes  int not null default 15
                      check (cooldown_minutes between 0 and 1440),
  -- {start:0-23, end:0-23, tz_offset_minutes:int} or NULL = any time. start==end
  -- means all day; start>end wraps midnight.
  active_hours      jsonb,

  -- Runtime state (edge trigger + cooldown).
  is_active         boolean not null default false,      -- currently latched (breaching, not yet cleared)
  last_fired_at     timestamptz,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists automations_owner_idx
  on automations (owner_user_id);
-- The hot path: which enabled rules watch this (device, metric)?
create index if not exists automations_trigger_idx
  on automations (trigger_device_id, metric_key) where enabled;

grant select, insert, update, delete on public.automations to service_role;
