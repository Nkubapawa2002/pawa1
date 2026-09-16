-- ============================================================================
--  account_kinds_real.sql — four kinds of account, and two of them stop being
--  decoration.
-- ============================================================================
--  WHAT WAS MEASURED FIRST
--  login.html has offered four account types since it shipped -- Agent, House
--  owner, Job company, Just looking -- with descriptions and capability chips
--  in both languages. Counted in production on 2026-09-16:
--
--      auth.users                        28   (27 anonymous, 1 real)
--      public.account_kinds               0 rows
--      users with account_type metadata   0
--
--  Nobody had ever been recorded as anything. The picker wrote localStorage and
--  Supabase user metadata, and only the OWNER door ever called
--  account_kind_claim(); nothing claimed agent, company or user. And
--  account_kind() coalesces a missing row to 'agent', so every account in the
--  system was an agent as far as the database was concerned -- including one
--  that had picked "Just looking".
--
--  'company' and 'user' were valid values in a CHECK constraint and nothing
--  else. No trigger, no policy, no fee rule and no screen branched on either.
--  The only runtime branch on 'company' anywhere was a post-login redirect.
--
--  WHAT THIS FILE ADDS
--  The two kinds that meant nothing now mean something, and it is enforced HERE
--  rather than by hiding a button:
--
--      company   hires. Posts day jobs, picks a crew. Does NOT list houses,
--                trucks or services, so never meets the agent approval window
--                or the monthly fee.
--      user      browses, messages, claims day jobs. Lists nothing.
--
--  A UI that merely hid the portals would leave the type a signpost again, and
--  this whole feature exists because the last signpost was mistaken for a
--  fence. So a listing insert from a company or a user account is refused by
--  the database, in a sentence the screen shows as-is beside the offer to
--  switch.
--
--  WHY A TRIGGER AND NOT AN RLS POLICY. The insert policies on houses, trucks
--  and services are `owner_user_id = app_uid()` and are shared with admins
--  posting on somebody's behalf. Narrowing them would mean editing three
--  policies in another file and getting the admin arm right three times. A
--  before-insert trigger says it once, and it can RAISE -- a policy can only
--  refuse, and "new row violates row-level security policy" is not a sentence
--  anybody can act on. The message matters as much as the refusal here,
--  because the answer is "switch your account type", which the person can do.
--
--  NOTHING IS TAKEN FROM AN EXISTING ACCOUNT. account_kind() still defaults a
--  missing row to 'agent', and there are no rows, so every account that exists
--  today keeps exactly what it has. Only an account that has explicitly
--  claimed 'company' or 'user' is narrowed, and claiming is a thing a person
--  does on purpose. An account with no row is never refused: that is why the
--  check below tests for the two kinds by name rather than for "not agent and
--  not owner".
--
--  AND AN ADMIN IS NEVER REFUSED, the same exemption owner_post_gate() already
--  makes: an admin posting for somebody is doing support, not trading.
--
--  Idempotent. Safe to re-run. Depends on house_owner_accounts.sql for
--  account_kind() and on public.is_admin(). Run it AFTER that file: the
--  trigger added here fires alongside owner_post_gate, not instead of it.
--
--    usage:  node scripts/db/apply_sql.mjs supabase/features/account/account_kinds_real.sql
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Which kinds may put a listing in the catalogue
-- ---------------------------------------------------------------------------
-- One immutable function rather than the two names written into a trigger, for
-- the reason owner_post_limit() exists: changing who may list should be one
-- edit, and it should be visible in a diff.
create or replace function public.kind_may_list(p_kind text)
  returns boolean
  language sql
  immutable
  set search_path = public
as $$
  select coalesce(p_kind, 'agent') not in ('company', 'user');
$$;

comment on function public.kind_may_list(text) is
  'Agent and owner list in the catalogue. Company hires, user browses. A null '
  'or unknown kind is treated as agent, because an account with no row has '
  'always been an agent and must not be narrowed by this file.';

-- ---------------------------------------------------------------------------
-- 2. The gate
-- ---------------------------------------------------------------------------
create or replace function public.listing_kind_gate()
  returns trigger
  language plpgsql
  security definer
  set search_path = public
as $fn$
declare
  v_owner text := new.owner_user_id;
  v_kind  text;
begin
  if coalesce(v_owner, '') = '' then return new; end if;

  -- Support, not trading. Same exemption owner_post_gate() makes.
  if public.is_admin() then return new; end if;

  v_kind := public.account_kind(v_owner);
  if public.kind_may_list(v_kind) then return new; end if;

  -- TWO SENTENCES, because the second one is the way out and the first one on
  -- its own reads as a dead end. The client shows this verbatim next to a
  -- control that changes the account type, so the wording has to survive being
  -- read without any UI around it.
  if v_kind = 'company' then
    raise exception 'A job company account posts day jobs, not property. Change your account type to Agent or House owner if you want to list %.',
      tg_argv[0];
  else
    raise exception 'This account is set to "Just looking", which browses and messages but does not list. Change your account type to Agent or House owner if you want to list %.',
      tg_argv[0];
  end if;
end $fn$;

drop trigger if exists houses_listing_kind_gate   on public.houses;
drop trigger if exists trucks_listing_kind_gate   on public.trucks;
drop trigger if exists services_listing_kind_gate on public.services;

-- BEFORE INSERT, and named so it sorts after owner_post_gate alphabetically
-- would be the wrong thing to rely on, so it does not: both are independent
-- and either may refuse. Postgres fires same-timing triggers in name order,
-- and these two do not interact -- owner_post_gate only acts on an owner, this
-- one only on a company or a user, and no account is both.
create trigger houses_listing_kind_gate
  before insert on public.houses
  for each row execute function public.listing_kind_gate('a house');

create trigger trucks_listing_kind_gate
  before insert on public.trucks
  for each row execute function public.listing_kind_gate('a truck');

create trigger services_listing_kind_gate
  before insert on public.services
  for each row execute function public.listing_kind_gate('a service');

-- ---------------------------------------------------------------------------
-- 3. Reading your own kind, for the screen that shows it
-- ---------------------------------------------------------------------------
-- account_kind(p_uid) already exists and is SECURITY DEFINER over any uid,
-- which is right for the triggers and the fee gate that must answer for other
-- people. A client asking about ITSELF should not have to pass its own id, and
-- should not be able to pass somebody else's.
create or replace function public.my_account_kind()
  returns table (kind text, may_list boolean, is_default boolean)
  language sql
  stable
  security definer
  set search_path = public
as $$
  select public.account_kind(public.app_uid()),
         public.kind_may_list(public.account_kind(public.app_uid())),
         -- TRUE when there is no row, i.e. the answer is the 'agent' default
         -- rather than a choice anybody made. The screen says so: "treated as
         -- an agent" is honest, "you are an agent" is not.
         not exists (select 1 from public.account_kinds k where k.user_id = public.app_uid());
$$;

grant execute on function public.kind_may_list(text)  to anon, authenticated;
grant execute on function public.my_account_kind()    to anon, authenticated;

commit;

-- ---------------------------------------------------------------------------
--  After applying, these should hold:
--
--    select public.kind_may_list('agent');    -- t
--    select public.kind_may_list('owner');    -- t
--    select public.kind_may_list('company');  -- f
--    select public.kind_may_list('user');     -- f
--    select public.kind_may_list(null);       -- t  (no row = agent, unchanged)
--
--  and tests/account_kinds_test.mjs proves the trigger refuses a company and a
--  user, allows an agent and an owner, and never touches an account that has
--  no row at all.
-- ---------------------------------------------------------------------------
