-- DESTRUCTIVE. Drops the entire humid data model so schema.sql can rebuild it
-- from scratch for the multi-sensor model. Run this ONLY on the clean-slate
-- migration, when you are willing to lose all existing devices, readings, and
-- events. After this, run in order: schema.sql, seed.sql, ingest_function.sql,
-- grants.sql, cron.sql.

-- Drop old and new RPC signatures if present.
drop function if exists ingest_reading(text, real, real, bigint);
drop function if exists ingest_reading(text, text, jsonb);
drop function if exists ingest_reading(text, text, jsonb, timestamptz);
drop function if exists device_touch(text, text, text, text);
drop function if exists device_touch(text, text, text, text, int, int, text);
drop function if exists claim_device(text, text);

drop table if exists device_claim_challenges cascade;
drop table if exists events cascade;
drop table if exists readings_daily cascade;
drop table if exists readings_hourly cascade;
drop table if exists readings cascade;
drop table if exists device_metric_thresholds cascade;
drop table if exists devices cascade;
drop table if exists metrics cascade;
