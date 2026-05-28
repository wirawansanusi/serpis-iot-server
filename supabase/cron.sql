-- Requires pg_cron extension. Enable in Supabase Dashboard > Database > Extensions.
-- Run once after schema.sql. Rollups aggregate per (device, metric).

-- Roll up the previous hour into readings_hourly, every hour at :05.
select cron.schedule('rollup_hourly', '5 * * * *', $$
  insert into readings_hourly (device_id, metric_key, hour, val_min, val_max, val_avg, sample_count)
  select device_id, metric_key, date_trunc('hour', recorded_at),
         min(value), max(value), avg(value), count(*)
  from readings
  where recorded_at >= date_trunc('hour', now() - interval '1 hour')
    and recorded_at <  date_trunc('hour', now())
  group by device_id, metric_key, date_trunc('hour', recorded_at)
  on conflict (device_id, metric_key, hour) do update set
    val_min = excluded.val_min, val_max = excluded.val_max, val_avg = excluded.val_avg,
    sample_count = excluded.sample_count;
$$);

-- Roll up yesterday into readings_daily, daily at 00:10.
select cron.schedule('rollup_daily', '10 0 * * *', $$
  insert into readings_daily (device_id, metric_key, day, val_min, val_max, val_avg, sample_count, abnormal_event_count)
  select r.device_id, r.metric_key,
         (now() - interval '1 day')::date,
         min(r.value), max(r.value), avg(r.value), count(*),
         (select count(*) from events e
          where e.device_id = r.device_id
            and e.metric_key = r.metric_key
            and e.started_at::date = (now() - interval '1 day')::date)
  from readings r
  where r.recorded_at >= (now() - interval '1 day')::date
    and r.recorded_at <  now()::date
  group by r.device_id, r.metric_key
  on conflict (device_id, metric_key, day) do update set
    val_min = excluded.val_min, val_max = excluded.val_max, val_avg = excluded.val_avg,
    sample_count = excluded.sample_count,
    abnormal_event_count = excluded.abnormal_event_count;
$$);

-- Purge raw readings older than 7 days, daily at 03:00.
select cron.schedule('purge_readings', '0 3 * * *',
  $$delete from readings where recorded_at < now() - interval '7 days'$$);

-- Purge hourly rollups older than 90 days, weekly Sunday at 04:00.
select cron.schedule('purge_hourly', '0 4 * * 0',
  $$delete from readings_hourly where hour < now() - interval '90 days'$$);

-- Purge daily rollups older than 1 year, weekly Sunday at 04:10. Bounds the
-- only otherwise-unbounded table; daily rows are tiny so a year is cheap.
select cron.schedule('purge_daily', '10 4 * * 0',
  $$delete from readings_daily where day < (now() - interval '1 year')::date$$);
