-- Add a per-device upload cadence ("report interval"). The device always SAMPLES
-- humidity/temp every 5 minutes (cheap — Wi-Fi stays off); this column only
-- controls how often it powers up Wi-Fi to upload the batched readings, trading
-- data freshness for battery life. Owner-set from the mobile app, echoed back to
-- the device in each ingest response.
--
-- Allowed values mirror the app picker: 5, 10, 15, 30, 60 minutes. Default 5
-- keeps every existing device on its current behaviour. Idempotent.

alter table devices
  add column if not exists report_interval_minutes int not null default 5;

-- Constrain to the supported set. Drop-then-add so re-running stays idempotent
-- even if the allowed set is later widened.
alter table devices drop constraint if exists devices_report_interval_check;
alter table devices
  add constraint devices_report_interval_check
  check (report_interval_minutes in (5,10,15,30,60));
