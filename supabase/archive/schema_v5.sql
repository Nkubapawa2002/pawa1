-- =====================================================
-- Pawa Bus Cargo - Schema v5
-- 1. Make national_id optional in agent_applications
-- 2. Add secure RPC to check own application status
-- =====================================================

-- national_id is now optional (UI already removed required)
alter table agent_applications alter column national_id drop not null;

-- Secure function: lets an applicant check their own status by phone
-- Runs as admin (security definer) so it bypasses RLS on agent_applications
-- but only returns status + reject_reason — no sensitive fields exposed.
create or replace function check_application_status(p_phone text)
returns table(status text, reject_reason text)
language sql stable security definer set search_path = public as $$
  select a.status, a.reject_reason
  from agent_applications a
  where a.phone = p_phone
     or replace(a.phone, ' ', '') = replace(p_phone, ' ', '')
  order by a.created_at desc
  limit 1;
$$;
