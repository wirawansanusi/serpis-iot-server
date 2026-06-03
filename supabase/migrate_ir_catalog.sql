-- IR code catalog (global, read-only to users) + per-device remotes (owned).
--
-- Two layers:
--   * ir_brands / ir_models / ir_functions  — the shared library, seeded from
--     IRDB + Flipper-IRDB + a curated set (scripts/seed-ir-catalog.mjs).
--   * device_remotes / device_remote_buttons — instances attached to a user's
--     IR blaster, created EITHER from a catalog model ("add device") OR by DIY
--     learning (next phase). AC remotes carry ac_vendor and are panel-driven
--     (no buttons); discrete remotes (TV, audio, ...) have stored buttons.
--
-- Apply after schema.sql + migrate_ir.sql. Idempotent.

-- ---- Catalog -------------------------------------------------------------

create table if not exists ir_brands (
  id    uuid primary key default gen_random_uuid(),
  name  text not null,
  slug  text unique not null
);
create index if not exists ir_brands_name_idx on ir_brands (lower(name));

create table if not exists ir_models (
  id          uuid primary key default gen_random_uuid(),
  brand_id    uuid not null references ir_brands(id) on delete cascade,
  name        text not null,
  device_kind text not null default 'other'
                check (device_kind in ('tv','ac','audio','projector','fan','light','stb','other')),
  -- AC models: the IRremoteESP8266 protocol name (e.g. 'DAIKIN'). The app shows
  -- a climate panel and sends kind=ac. NULL for discrete devices.
  ac_vendor   text,
  source      text not null default 'curated',   -- curated | flipper | irdb
  source_ref  text,                              -- original file/path (provenance)
  created_at  timestamptz not null default now(),
  unique (brand_id, name, device_kind)
);
create index if not exists ir_models_brand_idx on ir_models (brand_id);
create index if not exists ir_models_kind_idx  on ir_models (device_kind);
create index if not exists ir_models_name_idx  on ir_models (lower(name));

-- Discrete buttons for a catalog model (Power, Vol+, ...). Empty for AC models.
-- `command` is a command-contract object WITHOUT an id (the id is assigned when
-- the button is actually fired via /api/devices/{id}/command).
create table if not exists ir_functions (
  id         uuid primary key default gen_random_uuid(),
  model_id   uuid not null references ir_models(id) on delete cascade,
  name       text not null,
  command    jsonb not null,
  sort_order int not null default 100
);
create index if not exists ir_functions_model_idx on ir_functions (model_id);

-- ---- Per-device remotes (owned) -----------------------------------------

create table if not exists device_remotes (
  id            uuid primary key default gen_random_uuid(),
  device_id     uuid not null references devices(id) on delete cascade,
  owner_user_id text not null,                  -- Clerk user id (== device owner)
  name          text not null,
  kind          text not null default 'other'
                  check (kind in ('tv','ac','audio','projector','fan','light','stb','other')),
  ac_vendor     text,                           -- set for AC remotes (panel-driven)
  model_id      uuid references ir_models(id) on delete set null,  -- provenance
  created_at    timestamptz not null default now()
);
create index if not exists device_remotes_device_idx on device_remotes (device_id);
create index if not exists device_remotes_owner_idx  on device_remotes (owner_user_id);

create table if not exists device_remote_buttons (
  id         uuid primary key default gen_random_uuid(),
  remote_id  uuid not null references device_remotes(id) on delete cascade,
  label      text not null,
  command    jsonb not null,
  sort_order int not null default 100,
  created_at timestamptz not null default now()
);
create index if not exists device_remote_buttons_remote_idx on device_remote_buttons (remote_id);

grant select, insert, update, delete on
  public.ir_brands, public.ir_models, public.ir_functions,
  public.device_remotes, public.device_remote_buttons
to service_role;
