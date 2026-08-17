-- Fix: approve_agent_application was defined THREE times in the live DB
-- (overloads: (bigint), (integer), (integer,integer)). The single-arg call
-- from js/dashboard.js — sb.rpc('approve_agent_application', {p_app_id}) —
-- matched both single-arg overloads, so PostgREST returned
-- "could not choose the best candidate function" and the tenant dashboard's
-- Approve button was broken.
--
-- This collapses them to ONE canonical function and merges the best of each:
--   * signature (p_app_id bigint, p_initial_rating int default null)
--       → serves both call sites: dashboard (1 arg) and admin (2 args),
--         and matches agent_applications.id (bigint).
--   * tenant_id = app.tenant_id  → keeps the fix_approve_agent_tenant.sql
--       behaviour (approved agents land in the approving tenant, NOT the
--       demo-tenant default that agents.tenant_id falls back to).
--   * photo_path + rating_avg/rating_count → keeps the newer schema_master
--       behaviour (carry the application photo, seed an optional rating).
--   * security definer + set search_path = public → hardened.
--
-- Idempotent. Safe to re-run.

drop function if exists public.approve_agent_application(bigint);
drop function if exists public.approve_agent_application(integer);
drop function if exists public.approve_agent_application(integer, integer);

create or replace function public.approve_agent_application(
  p_app_id bigint, p_initial_rating int default null
)
returns text language plpgsql security definer set search_path = public as $fn$
declare
  app    agent_applications%rowtype;
  new_id text;
begin
  if not is_admin() then raise exception 'only admins can approve'; end if;

  select * into app from agent_applications where id = p_app_id;
  if not found then raise exception 'application not found'; end if;
  if app.status <> 'pending' then raise exception 'already %', app.status; end if;
  if p_initial_rating is not null and (p_initial_rating < 1 or p_initial_rating > 5) then
    raise exception 'rating must be between 1 and 5';
  end if;

  select 'AG' || lpad((coalesce(max(substring(id from 3)::int), 0) + 1)::text, 3, '0')
    into new_id from agents where id ~ '^AG[0-9]+$';
  if new_id is null then new_id := 'AG001'; end if;

  insert into agents
    (id, name, phone, region, terminal, buses,
     email, national_id, experience_years, about, verified, photo_path,
     tenant_id, rating_avg, rating_count)
  values
    (new_id, app.full_name, app.phone, app.region, app.terminal, app.buses,
     app.email, app.national_id, app.experience_years, app.about, true, app.photo_path,
     app.tenant_id,
     coalesce(p_initial_rating, 0),
     case when p_initial_rating is not null then 1 else 0 end);

  update agent_applications
     set status      = 'approved',
         reviewed_by = coalesce(auth.jwt() ->> 'email', 'admin'),
         reviewed_at = now()
   where id = p_app_id;

  return new_id;
end;
$fn$;

grant execute on function public.approve_agent_application(bigint, int) to authenticated;
