-- One-time migration: add wipe_credentials_pending to devices. When a user
-- removes a device from their account, this flag is set; the very next ingest
-- response tells the firmware to clear stored Wi-Fi credentials and reboot
-- into BLE provisioning mode for a clean handover. Idempotent.

alter table devices
  add column if not exists wipe_credentials_pending boolean not null default false;
