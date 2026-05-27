-- RPCs for ingest + BLE claiming. Devices are keyed by public_device_id (the
-- stable external identity injected at provisioning); MAC is diagnostic only.

-- Heartbeat / status upsert. Called on every ingest (claimed or not). Refreshes
-- last_seen + diagnostics and returns the device's claim_state so the route can
-- shape its response. Auto-creates an unclaimed row if the device is unknown
-- (it then can't be claimed until provisioned with a secret).
create or replace function device_touch(
  p_public_id       text,
  p_mac             text,
  p_device_type     text,
  p_firmware        text,
  p_battery_mv      int,
  p_battery_percent int,
  p_power_source    text
) returns text
language plpgsql
security definer
as $$
declare
  v_state text;
begin
  insert into devices (public_device_id, mac, device_type, firmware_version,
                       battery_mv, battery_percent, power_source, last_seen)
    values (p_public_id, nullif(p_mac, ''), nullif(p_device_type, ''), nullif(p_firmware, ''),
            p_battery_mv, p_battery_percent, nullif(p_power_source, ''), now())
    on conflict (public_device_id) do update set
      last_seen        = now(),
      mac              = coalesce(nullif(excluded.mac, ''), devices.mac),
      device_type      = coalesce(nullif(excluded.device_type, ''), devices.device_type),
      firmware_version = coalesce(nullif(excluded.firmware_version, ''), devices.firmware_version),
      battery_mv       = excluded.battery_mv,
      battery_percent  = excluded.battery_percent,
      power_source     = coalesce(nullif(excluded.power_source, ''), devices.power_source)
    returning claim_state into v_state;
  return v_state;
end;
$$;

-- Atomically bind a device to a user. Proof is verified in the API route BEFORE
-- this is called; the guard prevents double-claim and cross-user theft. Returns
-- true if this call performed the claim.
create or replace function claim_device(
  p_public_id text,
  p_user_id   text
) returns boolean
language plpgsql
security definer
as $$
declare
  v_updated int;
begin
  update devices
    set owner_user_id = p_user_id,
        claim_state   = 'claimed',
        claimed_at    = now()
    where public_device_id = p_public_id
      and claim_state <> 'claimed'
      and (owner_user_id is null or owner_user_id = p_user_id);
  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

drop function if exists ingest_reading(text, text, jsonb);

-- Atomic multi-metric ingest, keyed by public_device_id. Called only once a
-- device is claimed (heartbeat-only until then). Auto-registers unknown metric
-- keys, stores readings, seeds per-device thresholds, opens/closes high/low
-- events. p_metrics is a JSONB array of { key, value, unit?, label?, chart_type? }.
create or replace function ingest_reading(
  p_public_id   text,
  p_device_type text,
  p_metrics     jsonb,
  p_recorded_at timestamptz default now()
) returns void
language plpgsql
security definer
as $$
declare
  v_device      devices%rowtype;
  v_metric      jsonb;
  v_key         text;
  v_value       real;
  v_recorded_at timestamptz := coalesce(p_recorded_at, now());
  v_thr         device_metric_thresholds%rowtype;
  v_count       int;
  v_palette     text[] := array[
    '#4d9fff','#ef6b63','#3ec07a','#f0c46a',
    '#a78bfa','#22b8cf','#f06595','#94d82d'
  ];
begin
  if v_recorded_at > now() + interval '1 minute' then
    v_recorded_at := now();
  elsif v_recorded_at < now() - interval '7 days' then
    v_recorded_at := now() - interval '7 days';
  end if;

  select * into v_device from devices where public_device_id = p_public_id;
  if not found then
    return;  -- unknown device; device_touch normally creates the row first
  end if;

  for v_metric in select * from jsonb_array_elements(p_metrics)
  loop
    v_key := lower(v_metric->>'key');
    continue when v_key is null or v_key = '' or (v_metric->>'value') is null;
    v_value := (v_metric->>'value')::real;

    select count(*) into v_count from metrics;
    insert into metrics (key, label, unit, chart_type, color)
      values (
        v_key,
        coalesce(nullif(v_metric->>'label', ''), initcap(replace(v_key, '_', ' '))),
        coalesce(v_metric->>'unit', ''),
        coalesce(nullif(v_metric->>'chart_type', ''), 'line'),
        v_palette[(v_count % array_length(v_palette, 1)) + 1]
      )
      on conflict (key) do nothing;

    insert into readings (device_id, metric_key, value, recorded_at)
      values (v_device.id, v_key, v_value, v_recorded_at);

    insert into device_metric_thresholds (device_id, metric_key, min_val, max_val)
      select v_device.id, v_key, m.default_min, m.default_max
      from metrics m where m.key = v_key
      on conflict (device_id, metric_key) do nothing;

    select * into v_thr from device_metric_thresholds
      where device_id = v_device.id and metric_key = v_key;

    -- high event
    if v_thr.max_val is not null and v_value > v_thr.max_val then
      insert into events (device_id, metric_key, direction, started_at, peak_value, trigger_value, threshold)
        values (v_device.id, v_key, 'high', v_recorded_at, v_value, v_value, v_thr.max_val)
        on conflict (device_id, metric_key, direction) where ended_at is null do nothing;
      update events set peak_value = greatest(peak_value, v_value)
        where device_id = v_device.id and metric_key = v_key
          and direction = 'high' and ended_at is null;
    else
      update events set ended_at = v_recorded_at
        where device_id = v_device.id and metric_key = v_key
          and direction = 'high' and ended_at is null;
    end if;

    -- low event
    if v_thr.min_val is not null and v_value < v_thr.min_val then
      insert into events (device_id, metric_key, direction, started_at, peak_value, trigger_value, threshold)
        values (v_device.id, v_key, 'low', v_recorded_at, v_value, v_value, v_thr.min_val)
        on conflict (device_id, metric_key, direction) where ended_at is null do nothing;
      update events set peak_value = least(peak_value, v_value)
        where device_id = v_device.id and metric_key = v_key
          and direction = 'low' and ended_at is null;
    else
      update events set ended_at = v_recorded_at
        where device_id = v_device.id and metric_key = v_key
          and direction = 'low' and ended_at is null;
    end if;
  end loop;
end;
$$;
