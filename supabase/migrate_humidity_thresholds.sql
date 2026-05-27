-- One-time migration: retune the humidity safe band to the storage range
-- recommended for camera lenses / electronics (40–50% RH). Below ~40% risks
-- drying lens lubricants and rubber seals; above ~50% invites fungus and
-- corrosion. Previous band was 30–65%.
--
-- This affects BOTH the dashboard's in-range coloring / chart highlight AND
-- alerting: ingest opens a "high" event above 50% and a "low" event below 40%.
-- Historical events are left untouched (they were evaluated at ingest time);
-- only new readings use the new band. Idempotent.

-- 1. Registry defaults — applied to any NEW device that starts reporting humidity.
update metrics
  set default_min = 40, default_max = 50
  where key = 'humidity';

-- 2. Existing devices — adopt the new band now. Drop the WHERE device clause to
--    apply to every device (intended: this is the global safe range for gear).
update device_metric_thresholds
  set min_val = 40, max_val = 50
  where metric_key = 'humidity';
