-- One-time migration: add OTA firmware update support to an existing database.
-- Adds the firmware release registry and per-device OTA state. Non-destructive;
-- idempotent. After running, also run grants.sql (updated) so service_role can
-- read/write the new tables. See ota-firmware-update-prd.md.

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

grant select, insert, update, delete on
  public.firmware_releases,
  public.device_ota
to service_role;
