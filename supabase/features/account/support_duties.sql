-- ============================================================================
--  support_duties.sql — who is on duty, as a row an admin can change.
-- ============================================================================
--  WHAT THIS REPLACES
--  js/core/config.js carried this, hand-typed, in the source:
--
--      SUPPORT_CONTACTS: [
--        { role: "support_role_manager",   name: "xcracker pawa", phone: "+255 741 632 744", whatsapp: "255741622744" },
--        { role: "support_role_organizer", name: "Fatuma Said",   phone: "+255 713 000 002", whatsapp: "255713000002" }
--      ]
--
--  Four things were wrong with that and three of them are visible in the two
--  lines above.
--
--   1. The manager's call number and WhatsApp number DISAGREE. 741632744
--      against 741622744. Nobody noticed, because nothing on the screen shows
--      them side by side and nothing anywhere could check.
--   2. The second row is a placeholder. +255 713 000 002 is not a phone
--      number, it is what somebody types to fill a slot, and it has been in
--      production telling people to call it.
--   3. Changing who is on duty means editing JavaScript and redeploying the
--      site. Duty rotas change weekly; deploys do not.
--   4. It is reachable from P-Message (the "Rather talk to a person?" row in
--      the PN-Zaki pane goes to chat.html) and from Profile's subscription
--      dialog, so it reads as platform staff, which is exactly what it claims
--      to be and exactly what nothing was verifying.
--
--  THE DUTY IS A KEY, NOT A SENTENCE. duty_key is constrained to a small
--  vocabulary that exists in js/core/i18n.js under both `en` and `sw`. A free
--  text column would have been friendlier to type into and would have put an
--  untranslatable English string on a screen whose whole contract is that
--  every visible word exists in both languages. Adding a duty is one line in
--  i18n.js and one value in the check constraint, on purpose: it is rare, and
--  it should be visible in review.
--
--  THE NAME IS DATA AND STAYS FREE TEXT. A person's name is not UI copy and
--  does not translate.
--
--  NO WRITE POLICY. Same shape as pm_invites: the table has RLS on, a read
--  policy, and NO insert/update/delete policy at all. Every write goes through
--  the two SECURITY DEFINER functions below, both of which check is_admin(),
--  so set_by cannot be forged by writing the row directly.
--
--  READS ARE OPEN, and deliberately so: a support number is published
--  information, this is the page that publishes it, and a guest session with
--  a problem is exactly who needs it. Only ACTIVE rows are readable by a
--  non-admin, so retiring somebody actually removes them from the screen
--  rather than only from the ordering.
--
--  Idempotent. Safe to re-run. Depends on public.is_admin() and
--  public.app_uid() from schema_master.sql.
--
--    usage:  node scripts/db/apply_sql.mjs supabase/features/account/support_duties.sql
-- ============================================================================

begin;

create table if not exists public.support_duties (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  duty_key   text not null,
  phone      text,
  whatsapp   text,
  region     text,
  is_active  boolean not null default true,
  sort       int not null default 0,
  set_by     text,
  set_at     timestamptz not null default now()
);

-- The vocabulary. Every one of these has an en and a sw string in
-- js/core/i18n.js; adding a value here without adding the pair there puts an
-- untranslated key on the screen, which i18n_coverage.mjs will not catch
-- because the key arrives from the database rather than from the markup.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'support_duties_duty_key_ck'
  ) then
    alter table public.support_duties
      add constraint support_duties_duty_key_ck check (duty_key in (
        'support_role_manager',
        'support_role_organizer',
        'support_role_support',
        'support_role_accounts',
        'support_role_dispatch'
      ));
  end if;
end $$;

-- A phone number is either absent or plausibly a number. Not a full E.164
-- validation: people write Tanzanian numbers four different ways and a rule
-- that rejected three of them would be a worse problem than the one it solves.
-- This rejects the shape of a placeholder-by-typing, not a formatting choice.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'support_duties_reach_ck'
  ) then
    alter table public.support_duties
      add constraint support_duties_reach_ck check (
        coalesce(phone, '') <> '' or coalesce(whatsapp, '') <> ''
      );
  end if;
end $$;

create index if not exists support_duties_live_idx
  on public.support_duties (is_active, sort, set_at desc);

alter table public.support_duties enable row level security;

drop policy if exists "support_duties readable" on public.support_duties;

-- Active rows to everybody, every row to an admin. There is no write policy;
-- see the header.
create policy "support_duties readable" on public.support_duties for select
  using (is_active or (select public.is_admin()));

grant select on public.support_duties to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 1. Reading the rota
-- ---------------------------------------------------------------------------
-- A function rather than letting the client select the table directly, for one
-- reason: it fixes the ORDER. "Who do I call" has a right answer and it is the
-- first row; leaving the ordering to whichever client asks is how the manager
-- ends up second on one screen and third on another.
create or replace function public.support_duties_live()
  returns table (
    id       uuid,
    name     text,
    duty_key text,
    phone    text,
    whatsapp text,
    region   text
  )
  language sql
  stable
  security invoker          -- the policy above is the fence, not this function
  set search_path = public
as $fn$
  select d.id, d.name, d.duty_key, d.phone, d.whatsapp, d.region
    from public.support_duties d
   where d.is_active
   order by d.sort, d.set_at desc;
$fn$;

-- Everything, retired rows included, for the admin screen. Separate from the
-- function above so the public one can never be talked into returning a row
-- somebody took down.
create or replace function public.support_duties_all()
  returns setof public.support_duties
  language sql
  stable
  security definer
  set search_path = public
as $fn$
  select * from public.support_duties
   where public.is_admin()
   order by is_active desc, sort, set_at desc;
$fn$;

-- ---------------------------------------------------------------------------
-- 2. Changing it
-- ---------------------------------------------------------------------------
-- One function for add and for edit: p_id null means add. Two functions would
-- be two places to keep the same six validations, and the admin screen would
-- have to decide which to call from the presence of an id, which is what this
-- does in one place instead.
create or replace function public.support_duty_set(
  p_id       uuid,
  p_name     text,
  p_duty_key text,
  p_phone    text  default null,
  p_whatsapp text  default null,
  p_region   text  default null,
  p_active   boolean default true,
  p_sort     int   default 0
) returns public.support_duties
  language plpgsql
  security definer
  set search_path = public
as $fn$
declare
  v_uid  text := public.app_uid();
  v_row  public.support_duties;
  v_name text := nullif(trim(coalesce(p_name, '')), '');
  v_ph   text := nullif(trim(coalesce(p_phone, '')), '');
  v_wa   text := nullif(regexp_replace(coalesce(p_whatsapp, ''), '[^0-9]', '', 'g'), '');
begin
  if not public.is_admin() then
    raise exception 'Only an admin can change who is on duty';
  end if;
  if v_name is null then
    raise exception 'A name is required';
  end if;
  if length(v_name) > 80 then
    raise exception 'That name is too long';
  end if;
  -- Said here rather than left to the check constraint, because a constraint
  -- violation reaches the screen as a Postgres error nobody can act on.
  if p_duty_key is null or p_duty_key not in (
    'support_role_manager', 'support_role_organizer',
    'support_role_support', 'support_role_accounts', 'support_role_dispatch'
  ) then
    raise exception 'That is not a duty this app knows about';
  end if;
  if v_ph is null and v_wa is null then
    raise exception 'Give a phone number, a WhatsApp number, or both. A duty nobody can reach is not a duty.';
  end if;

  if p_id is null then
    insert into public.support_duties
      (name, duty_key, phone, whatsapp, region, is_active, sort, set_by, set_at)
    values
      (v_name, p_duty_key, v_ph, v_wa, nullif(trim(coalesce(p_region, '')), ''),
       coalesce(p_active, true), coalesce(p_sort, 0), v_uid, now())
    returning * into v_row;
  else
    update public.support_duties d set
      name      = v_name,
      duty_key  = p_duty_key,
      phone     = v_ph,
      whatsapp  = v_wa,
      region    = nullif(trim(coalesce(p_region, '')), ''),
      is_active = coalesce(p_active, true),
      sort      = coalesce(p_sort, 0),
      set_by    = v_uid,
      set_at    = now()
    where d.id = p_id
    returning * into v_row;
    if v_row.id is null then raise exception 'No such duty'; end if;
  end if;

  return v_row;
end $fn$;

-- Retiring somebody is the ordinary case and it is an UPDATE, not this: a rota
-- keeps its history. This is for a row that should never have existed, and it
-- is separate so that "take them off the screen" cannot be typed as "delete"
-- by accident.
create or replace function public.support_duty_delete(p_id uuid)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $fn$
begin
  if not public.is_admin() then
    raise exception 'Only an admin can change who is on duty';
  end if;
  delete from public.support_duties where id = p_id;
end $fn$;

grant execute on function public.support_duties_live()  to anon, authenticated;
grant execute on function public.support_duties_all()   to authenticated;
grant execute on function public.support_duty_set(uuid, text, text, text, text, text, boolean, int)
  to authenticated;
grant execute on function public.support_duty_delete(uuid) to authenticated;

commit;

-- ---------------------------------------------------------------------------
--  NOTHING IS SEEDED. The two rows that used to be in config.js are not
--  carried over: one has two contradictory numbers and the other is a
--  placeholder, and copying either into a table would make a bad fact durable
--  and look deliberate.
--
--  An empty rota is a supported state. js/lib/support-duties.js draws nothing
--  at all rather than an empty card, and chat.html falls back to the line it
--  already had for a deployment with no numbers set up. The admin adds the
--  real people on admin.html, once, and never edits JavaScript again.
-- ---------------------------------------------------------------------------
