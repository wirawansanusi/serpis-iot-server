-- DIY learn: store the captured IR code on the originating learn command.
--
-- A learn command (command = {kind:"learn", timeout_s}) is enqueued like any
-- other; the device arms IRrecv and, when the user presses their remote, replies
-- on .../evt with {kind:"learned", ok, command:{...}}. The evt subscriber writes
-- that captured command object here so the app can poll it (and then save it as
-- a device_remote_buttons row with a user-chosen label).
--
-- Apply after migrate_ir.sql. Idempotent.

alter table device_commands
  add column if not exists result jsonb;   -- learned command object (kind protocol|raw)
