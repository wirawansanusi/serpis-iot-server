-- IR blaster: command queue.
--
-- The IR blaster (device_type = 'ir-blaster-esp32c3') is mains-powered and holds
-- a persistent MQTT connection. Commands are delivered in near-real-time by
-- publishing to serpis/ir/<public_device_id>/cmd; this table is the durable
-- record + ack status (the device replies on .../evt). Apply after schema.sql.
--
-- Idempotent.

create table if not exists device_commands (
  id          uuid primary key default gen_random_uuid(),
  device_id   uuid not null references devices(id) on delete cascade,
  -- The full command object delivered to the device (the shared "command
  -- contract"): {kind:"ac"|"protocol"|"raw"|"macro", ...}. Stored verbatim so
  -- the exact bytes the device received are auditable.
  command     jsonb not null,
  status      text not null default 'queued'
                check (status in ('queued','sent','acked','failed','expired')),
  created_by  text,                          -- Clerk user id that issued it (audit)
  created_at  timestamptz not null default now(),
  sent_at     timestamptz,                   -- published to MQTT
  acked_at    timestamptz,                   -- device reported a result on .../evt
  ack_ok      boolean,
  ack_error   text
);

create index if not exists device_commands_device_idx
  on device_commands (device_id, created_at desc);
create index if not exists device_commands_pending_idx
  on device_commands (device_id) where status = 'queued';

grant select, insert, update, delete on public.device_commands to service_role;
