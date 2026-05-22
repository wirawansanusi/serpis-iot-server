-- Requires pg_cron extension. Enable in Supabase Dashboard > Database > Extensions.
-- Run once after schema.sql.

-- Roll up the previous hour into readings_hourly, every hour at :05.
select cron.schedule('rollup_hourly', '5 * * * *', $$
  insert into readings_hourly (device_id, hour, temp_min, temp_max, temp_avg, hum_min, hum_max, hum_avg, sample_count)
  select device_id, date_trunc('hour', recorded_at),
         min(temp_c), max(temp_c), avg(temp_c),
         min(humidity), max(humidity), avg(humidity),
         count(*)
  from readings
  where recorded_at >= date_trunc('hour', now() - interval '1 hour')
    and recorded_at <  date_trunc('hour', now())
  group by device_id, date_trunc('hour', recorded_at)
  on conflict (device_id, hour) do update set
    temp_min = excluded.temp_min, temp_max = excluded.temp_max, temp_avg = excluded.temp_avg,
    hum_min  = excluded.hum_min,  hum_max  = excluded.hum_max,  hum_avg  = excluded.hum_avg,
    sample_count = excluded.sample_count;
$$);

-- Roll up yesterday into readings_daily, daily at 00:10.
select cron.schedule('rollup_daily', '10 0 * * *', $$
  insert into readings_daily (device_id, day, temp_min, temp_max, temp_avg, hum_min, hum_max, hum_avg, sample_count, abnormal_event_count)
  select r.device_id,
         (now() - interval '1 day')::date,
         min(r.temp_c), max(r.temp_c), avg(r.temp_c),
         min(r.humidity), max(r.humidity), avg(r.humidity),
         count(*),
         (select count(*) from events e
          where e.device_id = r.device_id
            and e.started_at::date = (now() - interval '1 day')::date)
  from readings r
  where r.recorded_at >= (now() - interval '1 day')::date
    and r.recorded_at <  now()::date
  group by r.device_id
  on conflict (device_id, day) do update set
    temp_min = excluded.temp_min, temp_max = excluded.temp_max, temp_avg = excluded.temp_avg,
    hum_min  = excluded.hum_min,  hum_max  = excluded.hum_max,  hum_avg  = excluded.hum_avg,
    sample_count = excluded.sample_count,
    abnormal_event_count = excluded.abnormal_event_count;
$$);

-- Purge raw readings older than 7 days, daily at 03:00.
select cron.schedule('purge_readings', '0 3 * * *',
  $$delete from readings where recorded_at < now() - interval '7 days'$$);

-- Purge hourly rollups older than 90 days, weekly Sunday at 04:00.
select cron.schedule('purge_hourly', '0 4 * * 0',
  $$delete from readings_hourly where hour < now() - interval '90 days'$$);
