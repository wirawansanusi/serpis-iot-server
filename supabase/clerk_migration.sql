-- Migrate from Supabase Auth to Clerk for user identity.
--
-- What this does:
--   1. Drops the FK from devices.owner_user_id → auth.users(id)
--   2. Clears any existing owner_user_id values (they were Supabase auth UUIDs;
--      Clerk uses different ids like "user_2NN..."). You'll re-claim devices
--      after signing in with your new Clerk account.
--   3. Changes owner_user_id type from uuid to text (Clerk ids are strings).
--   4. Drops any RLS policies that referenced auth.uid() and disables RLS.
--      We're filtering by owner_user_id server-side now instead.
--   5. Adds an index on owner_user_id so user-scoped queries are fast.
--
-- Safe to re-run.

-- 1 + 3: column type change (drop FK first since it references auth.users)
alter table devices drop constraint if exists devices_owner_user_id_fkey;

-- 2: clear existing claims
update devices set owner_user_id = null where owner_user_id is not null;

-- 3: change type — only works if all values are null (which we just ensured)
alter table devices alter column owner_user_id type text;

-- 4: drop RLS policies (referenced auth.uid()) and disable RLS
drop policy if exists devices_owner_select        on devices;
drop policy if exists devices_owner_update        on devices;
drop policy if exists devices_owner_delete        on devices;
drop policy if exists readings_owner_select       on readings;
drop policy if exists readings_hourly_owner_select on readings_hourly;
drop policy if exists readings_daily_owner_select  on readings_daily;
drop policy if exists events_owner_select         on events;

alter table devices         disable row level security;
alter table readings        disable row level security;
alter table readings_hourly disable row level security;
alter table readings_daily  disable row level security;
alter table events          disable row level security;

-- 5: index for the new owner_user_id query pattern
create index if not exists devices_owner_idx on devices(owner_user_id);
