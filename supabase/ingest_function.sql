-- Atomic per-reading ingest. Inserts the reading and opens/closes any
-- abnormal-condition events for the device. Called from /api/ingest via
-- supabase.rpc('ingest_reading', { ... }).

create or replace function ingest_reading(
  p_mac      text,
  p_temp     real,
  p_humidity real,
  p_uptime   bigint
) returns void
language plpgsql
security definer
as $$
declare
  v_device devices%rowtype;
begin
  insert into devices (mac, last_seen)
    values (p_mac, now())
    on conflict (mac) do update set last_seen = excluded.last_seen
    returning * into v_device;

  insert into readings (device_id, temp_c, humidity, uptime_ms)
    values (v_device.id, p_temp, p_humidity, p_uptime);

  -- humidity_high
  if p_humidity > v_device.humidity_max then
    insert into events (device_id, kind, peak_value, trigger_value, threshold)
      values (v_device.id, 'humidity_high', p_humidity, p_humidity, v_device.humidity_max)
      on conflict (device_id, kind) where ended_at is null do nothing;
    update events set peak_value = greatest(peak_value, p_humidity)
      where device_id = v_device.id and kind = 'humidity_high' and ended_at is null;
  else
    update events set ended_at = now()
      where device_id = v_device.id and kind = 'humidity_high' and ended_at is null;
  end if;

  -- humidity_low
  if p_humidity < v_device.humidity_min then
    insert into events (device_id, kind, peak_value, trigger_value, threshold)
      values (v_device.id, 'humidity_low', p_humidity, p_humidity, v_device.humidity_min)
      on conflict (device_id, kind) where ended_at is null do nothing;
    update events set peak_value = least(peak_value, p_humidity)
      where device_id = v_device.id and kind = 'humidity_low' and ended_at is null;
  else
    update events set ended_at = now()
      where device_id = v_device.id and kind = 'humidity_low' and ended_at is null;
  end if;

  -- temp_high
  if p_temp > v_device.temp_max then
    insert into events (device_id, kind, peak_value, trigger_value, threshold)
      values (v_device.id, 'temp_high', p_temp, p_temp, v_device.temp_max)
      on conflict (device_id, kind) where ended_at is null do nothing;
    update events set peak_value = greatest(peak_value, p_temp)
      where device_id = v_device.id and kind = 'temp_high' and ended_at is null;
  else
    update events set ended_at = now()
      where device_id = v_device.id and kind = 'temp_high' and ended_at is null;
  end if;

  -- temp_low
  if p_temp < v_device.temp_min then
    insert into events (device_id, kind, peak_value, trigger_value, threshold)
      values (v_device.id, 'temp_low', p_temp, p_temp, v_device.temp_min)
      on conflict (device_id, kind) where ended_at is null do nothing;
    update events set peak_value = least(peak_value, p_temp)
      where device_id = v_device.id and kind = 'temp_low' and ended_at is null;
  else
    update events set ended_at = now()
      where device_id = v_device.id and kind = 'temp_low' and ended_at is null;
  end if;
end;
$$;
