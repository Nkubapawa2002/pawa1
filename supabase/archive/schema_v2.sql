-- =====================================================
-- Pawa Bus Cargo - Schema v2 (additions on top of schema.sql)
-- Run this AFTER schema.sql + seed.sql in the Supabase SQL editor.
-- Safe to re-run.
-- =====================================================

-- ---------- 1. Buses: add photo + verification ----------
alter table buses add column if not exists photo_path text;
alter table buses add column if not exists about text;
alter table buses add column if not exists verified boolean not null default true;

-- ---------- 2. Agents: add trust fields ----------
alter table agents add column if not exists email text;
alter table agents add column if not exists national_id text;
alter table agents add column if not exists experience_years int not null default 1;
alter table agents add column if not exists verified boolean not null default true;
alter table agents add column if not exists rating_avg numeric not null default 0;
alter table agents add column if not exists rating_count int not null default 0;

-- ---------- 3. Admins (gate for admin.html) ----------
create table if not exists admins (
  email text primary key,
  full_name text,
  created_at timestamptz default now()
);

-- Seed the project owner as admin
insert into admins (email, full_name) values ('pawa4761@gmail.com', 'Owner')
on conflict (email) do nothing;

-- Helper: is the current logged-in user an admin?
create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from admins a
    where a.email = (auth.jwt() ->> 'email')
  );
$$;

-- ---------- 4. Agent applications (self-register, awaits admin approval) ----------
create table if not exists agent_applications (
  id bigserial primary key,
  full_name text not null,
  phone text not null,
  email text,
  region text not null references regions(name) on update cascade,
  terminal text not null,
  buses text[] not null default '{}',
  experience_years int not null check (experience_years >= 1),
  national_id text not null,
  about text,
  status text not null default 'pending'
    check (status in ('pending','approved','rejected')),
  reject_reason text,
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz default now(),
  -- conditions
  constraint app_buses_nonempty check (array_length(buses, 1) >= 1)
);

create index if not exists agent_apps_status_idx on agent_applications (status, created_at);

-- ---------- 5. Agent reviews (trust signal) ----------
create table if not exists agent_reviews (
  id bigserial primary key,
  agent_id text not null references agents(id) on delete cascade,
  tracking_code text references shipments(tracking_code) on delete set null,
  rater_phone text not null,
  rater_name text,
  rating int not null check (rating between 1 and 5),
  comment text,
  created_at timestamptz default now(),
  unique (agent_id, tracking_code, rater_phone)
);

create index if not exists agent_reviews_agent_idx on agent_reviews (agent_id, created_at);

-- Recompute agent rating after every review change
create or replace function recompute_agent_rating(p_agent_id text)
returns void language sql as $$
  update agents a
  set rating_avg = coalesce((select avg(rating)::numeric(3,2) from agent_reviews where agent_id = p_agent_id), 0),
      rating_count = (select count(*) from agent_reviews where agent_id = p_agent_id)
  where a.id = p_agent_id;
$$;

create or replace function trg_agent_review_changed() returns trigger
language plpgsql as $$
begin
  if (tg_op = 'DELETE') then
    perform recompute_agent_rating(old.agent_id);
    return old;
  else
    perform recompute_agent_rating(new.agent_id);
    return new;
  end if;
end;
$$;

drop trigger if exists agent_reviews_aiud on agent_reviews;
create trigger agent_reviews_aiud
  after insert or update or delete on agent_reviews
  for each row execute function trg_agent_review_changed();

-- ---------- 6. Add a route + auto return leg ----------
-- Easy way to add a real route. Adds both legs to the bus's JSONB routes.
create or replace function add_bus_route(
  p_bus_id text,
  p_from text,
  p_to text,
  p_departure text,
  p_return_departure text,
  p_duration_hours numeric
) returns void language plpgsql security definer set search_path = public as $$
declare
  forward_leg jsonb;
  return_leg jsonb;
begin
  if not is_admin() then
    raise exception 'only admins can add routes';
  end if;

  forward_leg := jsonb_build_object(
    'from', p_from, 'to', p_to,
    'departure', p_departure,
    'duration_hours', p_duration_hours
  );
  return_leg := jsonb_build_object(
    'from', p_to, 'to', p_from,
    'departure', p_return_departure,
    'duration_hours', p_duration_hours
  );

  update buses
  set routes = coalesce(routes, '[]'::jsonb) || forward_leg || return_leg
  where id = p_bus_id;
end;
$$;

-- Remove all legs that match a from/to pair on a bus
create or replace function remove_bus_route(
  p_bus_id text,
  p_from text,
  p_to text
) returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then
    raise exception 'only admins can remove routes';
  end if;

  update buses b
  set routes = coalesce((
    select jsonb_agg(r)
    from jsonb_array_elements(b.routes) r
    where not (
      (r->>'from' = p_from and r->>'to' = p_to)
      or (r->>'from' = p_to and r->>'to' = p_from)
    )
  ), '[]'::jsonb)
  where b.id = p_bus_id;
end;
$$;

-- ---------- 7. Approve / reject an application ----------
create or replace function approve_agent_application(p_app_id bigint)
returns text language plpgsql security definer set search_path = public as $$
declare
  app agent_applications%rowtype;
  new_id text;
begin
  if not is_admin() then raise exception 'only admins can approve'; end if;

  select * into app from agent_applications where id = p_app_id;
  if not found then raise exception 'application not found'; end if;
  if app.status <> 'pending' then raise exception 'already %', app.status; end if;

  -- Generate next agent id
  select 'AG' || lpad(((coalesce(max(substring(id from 3)::int), 0)) + 1)::text, 3, '0')
    into new_id from agents where id ~ '^AG[0-9]+$';

  insert into agents (id, name, phone, region, terminal, buses,
                      email, national_id, experience_years, verified)
  values (new_id, app.full_name, app.phone, app.region, app.terminal, app.buses,
          app.email, app.national_id, app.experience_years, true);

  update agent_applications
  set status = 'approved',
      reviewed_by = (auth.jwt() ->> 'email'),
      reviewed_at = now()
  where id = p_app_id;

  return new_id;
end;
$$;

create or replace function reject_agent_application(p_app_id bigint, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'only admins can reject'; end if;
  update agent_applications
  set status = 'rejected',
      reject_reason = p_reason,
      reviewed_by = (auth.jwt() ->> 'email'),
      reviewed_at = now()
  where id = p_app_id and status = 'pending';
end;
$$;

-- ---------- 8. Row-Level-Security ----------
alter table admins enable row level security;
alter table agent_applications enable row level security;
alter table agent_reviews enable row level security;

-- Admins table: only admins can read/modify
drop policy if exists "admins read self" on admins;
create policy "admins read self" on admins for select using (is_admin());

drop policy if exists "admins write" on admins;
create policy "admins write" on admins for all using (is_admin()) with check (is_admin());

-- Agent applications: anyone can submit (insert), only admins can read/update
drop policy if exists "applications insert public" on agent_applications;
create policy "applications insert public" on agent_applications
  for insert with check (true);

drop policy if exists "applications read admin" on agent_applications;
create policy "applications read admin" on agent_applications
  for select using (is_admin());

drop policy if exists "applications update admin" on agent_applications;
create policy "applications update admin" on agent_applications
  for update using (is_admin()) with check (is_admin());

-- Agent reviews: anyone can read + insert; admins can delete
drop policy if exists "reviews readable" on agent_reviews;
create policy "reviews readable" on agent_reviews for select using (true);

drop policy if exists "reviews insertable" on agent_reviews;
create policy "reviews insertable" on agent_reviews for insert with check (true);

drop policy if exists "reviews admin delete" on agent_reviews;
create policy "reviews admin delete" on agent_reviews
  for delete using (is_admin());

-- Tighten existing tables: only admins can write to buses/agents/regions
drop policy if exists "buses admin write" on buses;
create policy "buses admin write" on buses
  for all using (is_admin()) with check (is_admin());

drop policy if exists "agents admin write" on agents;
create policy "agents admin write" on agents
  for all using (is_admin()) with check (is_admin());

drop policy if exists "regions admin write" on regions;
create policy "regions admin write" on regions
  for all using (is_admin()) with check (is_admin());

-- Realtime additions
alter publication supabase_realtime add table agent_applications;
alter publication supabase_realtime add table agent_reviews;
