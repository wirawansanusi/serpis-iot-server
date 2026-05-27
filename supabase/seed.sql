-- Seed the metric registry with the two metrics the Humid device reports, so
-- it renders exactly as before (humidity on the left axis, temperature on the
-- right) with its original alert thresholds. Run once after schema.sql.
--
-- `color` uses theme tokens (accent|good|bad|warn) instead of literal hex so
-- these adapt to light/dark mode the way the original chart did. Both default
-- to `accent` (blue) so the charts reserve red for out-of-range readings. Any
-- *other* metric a device reports is auto-registered by ingest_reading() with a
-- palette hex.
--
-- Idempotent: re-running refreshes the display config without touching data.

insert into metrics (key, label, unit, precision, chart_type, axis, color, default_min, default_max, sort_order)
values
  ('humidity', 'Humidity',    '%',  1, 'line', 'left',  'accent', 40, 50, 10),
  ('temp_c',   'Temperature', '°C', 1, 'line', 'right', 'accent', 10, 35, 20)
on conflict (key) do update set
  label       = excluded.label,
  unit        = excluded.unit,
  precision   = excluded.precision,
  chart_type  = excluded.chart_type,
  axis        = excluded.axis,
  color       = excluded.color,
  default_min = excluded.default_min,
  default_max = excluded.default_max,
  sort_order  = excluded.sort_order;
