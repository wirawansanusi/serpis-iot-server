-- IR remotes: store the catalog brand at add-time.
--
-- The hub app's remote redesign (2026-06-10) shows a device grid of tiles with
-- "icon + name + brand". Only AC remotes carried a vendor string (ac_vendor);
-- this adds a brand column populated from the catalog model's brand when a
-- remote is materialized via { model_id }. Hand-created remotes stay null and
-- the app falls back to ac_vendor, then nothing.
--
-- Sprint-fence note: this change ships under the one-time founder carve-out
-- recorded in the Evidence Sprint design doc (2026-06-10, design review D7).
--
-- Apply after migrate_ir.sql. Idempotent. No backfill: existing rows keep
-- brand = null (the app's fallback chain covers them); re-adding a remote
-- from the catalog picks the brand up.

alter table device_remotes add column if not exists brand text;
