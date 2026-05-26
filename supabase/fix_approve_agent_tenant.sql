-- ============================================================================
-- Fix: approve_agent_application RPC was inserting agents without tenant_id,
-- so every approved agent ended up in the demo tenant (default) and never
-- showed up in the approving tenant's dashboard.
--
-- All 3 overloads carry the same bug; we recreate them so each copies
-- app.tenant_id into the new agents row.
-- ============================================================================

create or replace function public.approve_agent_application(p_app_id bigint)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  app    agent_applications%rowtype;
  new_id text;
begin
  if not is_admin() then raise exception 'only admins can approve'; end if;

  select * into app from agent_applications where id = p_app_id;
  if not found then raise exception 'application not found'; end if;
  if app.status <> 'pending' then raise exception 'already %', app.status; end if;

  select 'AG' || lpad((coalesce(max(substring(id from 3)::int), 0) + 1)::text, 3, '0')
    into new_id from agents where id ~ '^AG[0-9]+$';
  if new_id is null then new_id := 'AG001'; end if;

  insert into agents
    (id, name, phone, region, terminal, buses,
     email, national_id, experience_years, about, verified, tenant_id)
  values
    (new_id, app.full_name, app.phone, app.region, app.terminal, app.buses,
     app.email, app.national_id, app.experience_years, app.about, true,
     app.tenant_id);

  update agent_applications
     set status      = 'approved',
         reviewed_by = coalesce(auth.jwt() ->> 'email', 'admin'),
         reviewed_at = now()
   where id = p_app_id;

  return new_id;
end;
$function$;

create or replace function public.approve_agent_application(p_app_id integer)
returns text
language plpgsql
security definer
as $function$
declare
  app    agent_applications%rowtype;
  new_id text;
begin
  if not is_admin() then raise exception 'only admins can approve'; end if;

  select * into app from agent_applications where id = p_app_id;
  if not found then raise exception 'application not found'; end if;
  if app.status <> 'pending' then raise exception 'already %', app.status; end if;

  select 'AG' || lpad((coalesce(max(substring(id from 3)::int), 0) + 1)::text, 3, '0')
    into new_id from agents where id ~ '^AG[0-9]+$';
  if new_id is null then new_id := 'AG001'; end if;

  insert into agents
    (id, name, phone, region, terminal, buses,
     email, national_id, experience_years, about, verified, photo_path, tenant_id)
  values
    (new_id, app.full_name, app.phone, app.region, app.terminal, app.buses,
     app.email, app.national_id, app.experience_years, app.about, true,
     app.photo_path, app.tenant_id);

  update agent_applications
     set status      = 'approved',
         reviewed_by = coalesce(auth.jwt() ->> 'email', 'admin'),
         reviewed_at = now()
   where id = p_app_id;

  return new_id;
end;
$function$;

create or replace function public.approve_agent_application(p_app_id integer, p_initial_rating integer default null)
returns text
language plpgsql
security definer
as $function$
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
     rating_avg, rating_count, tenant_id)
  values
    (new_id, app.full_name, app.phone, app.region, app.terminal, app.buses,
     app.email, app.national_id, app.experience_years, app.about, true, app.photo_path,
     coalesce(p_initial_rating, 0), case when p_initial_rating is not null then 1 else 0 end,
     app.tenant_id);

  update agent_applications
     set status      = 'approved',
         reviewed_by = coalesce(auth.jwt() ->> 'email', 'admin'),
         reviewed_at = now()
   where id = p_app_id;

  return new_id;
end;
$function$;

notify pgrst, 'reload schema';
