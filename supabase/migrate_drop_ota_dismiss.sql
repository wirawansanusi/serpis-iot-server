-- One-time migration: remove the unused `dismissed_version` column from
-- device_ota. Firmware updates can't be ignored by the user — the "Update
-- available" notification persists until they actually update — so the column
-- has no writer. Idempotent.
--
-- Skip this if you haven't already run migrate_ota_firmware.sql (the canonical
-- schema no longer creates the column).

alter table device_ota drop column if exists dismissed_version;
