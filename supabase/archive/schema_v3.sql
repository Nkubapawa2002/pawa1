-- =====================================================
-- Pawa Bus Cargo - Schema v3 (bug fixes)
-- Run this in the Supabase SQL editor AFTER schema_v2.sql
-- Safe to re-run.
-- =====================================================

-- ---------- 1. Add missing photo_path to agent_applications ----------
-- The agent-register form uploads a photo and sends photo_path in the insert,
-- but the column was never added to the table.
alter table agent_applications add column if not exists photo_path text;

-- ---------- 2. Make national_id nullable ----------
-- The registration form marks national_id as "(optional, recommended)" and has
-- no required attribute, but the column was NOT NULL — causing every submission
-- that leaves it blank to fail with a constraint violation.
alter table agent_applications alter column national_id drop not null;

-- ---------- 3. Add DELETE policy for agent_applications ----------
-- The "Withdraw Application" feature calls .delete() but no DELETE RLS policy
-- existed, so every withdrawal was silently blocked by RLS.
drop policy if exists "applications delete own" on agent_applications;
create policy "applications delete own" on agent_applications
  for delete using (status in ('pending', 'rejected'));

-- ---------- 4. Add generate_tracking_code RPC function ----------
-- data.js calls sb.rpc("generate_tracking_code", ...) on every shipment
-- registration. The function was missing so every call returned an error
-- (the JS fallback caught it, but it wastes a round-trip every time).
create or replace function generate_tracking_code(p_origin text, p_dest text)
returns text language sql security definer set search_path = public as $$
  select 'TZ-'
    || upper(substr(regexp_replace(coalesce(p_origin, ''), '[^a-zA-Z]', '', 'g'), 1, 3))
    || '-'
    || upper(substr(regexp_replace(coalesce(p_dest, ''), '[^a-zA-Z]', '', 'g'), 1, 3))
    || '-'
    || to_char(now() at time zone 'UTC', 'YYYYMMDD')
    || '-'
    || lpad((floor(random() * 9000) + 1000)::int::text, 4, '0')
    || '-'
    || lpad((floor(random() * 9000) + 1000)::int::text, 4, '0');
$$;
