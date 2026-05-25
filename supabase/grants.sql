-- Grant service_role access to the humid tables.
--
-- Why this is needed: Supabase usually auto-grants service_role on tables
-- created in the public schema, but this didn't happen on this project (likely
-- because the tables were created via the SQL editor before the auto-grant
-- trigger fired). The dashboard reads as service_role and was getting
-- "permission denied for table events".
--
-- Safe to run multiple times — GRANT is idempotent.
-- service_role is server-only (requires SERVICE_ROLE_KEY); this does NOT
-- expose data to anon/public callers.

grant select, insert, update, delete on
  public.devices,
  public.metrics,
  public.device_metric_thresholds,
  public.device_claim_challenges,
  public.readings,
  public.readings_hourly,
  public.readings_daily,
  public.events
to service_role;

grant usage, select on all sequences in schema public to service_role;

-- Make sure any future tables/sequences created in `public` also get granted
-- automatically, so we don't have to repeat this dance.
alter default privileges in schema public
  grant select, insert, update, delete on tables to service_role;

alter default privileges in schema public
  grant usage, select on sequences to service_role;
