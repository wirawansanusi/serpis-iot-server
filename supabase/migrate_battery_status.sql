-- One-time migration for an existing database: move battery from charted
-- metrics to device status, and clean up the stale battery metric rows.
-- Non-destructive to devices/readings for humidity & temperature.
--
-- After running this, re-run ingest_function.sql to install the updated
-- device_touch (it now takes the battery params). Both are idempotent.

-- 1. Battery status columns on devices.
alter table devices add column if not exists battery_percent int;
alter table devices add column if not exists battery_mv      int;
alter table devices add column if not exists power_source     text;

-- 2. Retire the old 4-arg device_touch (ingest_function.sql creates the new one).
drop function if exists device_touch(text, text, text, text);

-- 3. Remove the battery metrics that were being charted. Delete children before
--    the registry rows (they FK metrics.key).
delete from readings              where metric_key in ('battery_mv','power_mv','battery_percent');
delete from readings_hourly       where metric_key in ('battery_mv','power_mv','battery_percent');
delete from readings_daily        where metric_key in ('battery_mv','power_mv','battery_percent');
delete from events                where metric_key in ('battery_mv','power_mv','battery_percent');
delete from device_metric_thresholds where metric_key in ('battery_mv','power_mv','battery_percent');
delete from metrics               where key        in ('battery_mv','power_mv','battery_percent');
