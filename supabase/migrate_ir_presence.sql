-- MQTT link presence for always-on devices (the IR blaster).
--
-- The dashboard's `online` flag is freshness-based (last_seen within ~2 report
-- intervals). That's right for the battery sensor that only wakes to upload, but
-- the mains-powered IR blaster holds a live MQTT connection whose drop we learn
-- about INSTANTLY via the retained Last-Will. This column records that signal so
-- the app can show "offline" the moment the link drops, without waiting out the
-- freshness window.
--
--   true  => broker saw a live connection (retained status = "online")
--   false => Last-Will fired (status = "offline")
--   null  => no MQTT link signal (e.g. HTTP-only sensors) — fall back to freshness
--
-- Apply after schema.sql. Idempotent.

alter table devices
  add column if not exists link_online boolean;
