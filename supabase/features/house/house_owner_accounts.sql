-- ============================================================================
--  house_owner_accounts.sql — the landlord who is not an agent.
-- ============================================================================
--  js/lib/login-doors.js has offered four doors since it was written, and one
--  of them is marked VIP: "House owner. Your own property, listed by you, with
--  no agent in between." Until now that door was a signpost and nothing else.
--  The door's own header says so in as many words: it grants nothing, it is
--  stored in user metadata, and metadata is writable by the user it describes.
--
--  So a landlord walking through it landed in exactly the agent's building:
--
--    · agent_key_suspended() gave them SEVEN DAYS and then hid their listing
--      until an admin approved them and a monthly fee was paid. The one thing
--      the VIP door promises is the one thing they did not get.
--    · nothing anywhere said their listing came from the owner. A renter
--      reading the board could not tell the room with no agent margin on it
--      from the twenty with one.
--    · and there was no ceiling. "No fee" with no ceiling is a free listing
--      board, which is a spam board with our name on it by the end of the
--      month.
--
--  WHAT THIS FILE ESTABLISHES
--
--    account_kinds     the SERVER's record of what kind of account this is.
--                      Not metadata: metadata is the user's own to rewrite,
--                      and this one decides who pays.
--    owner_posts       every listing an owner account has ever created, kept
--                      whether or not the listing still exists.
--    the allowance     THREE posts per 180 days, in two functions so there is
--                      one place to change either number.
--    posted_by_owner   on houses, so a card can say "from the owner" without
--                      reading anybody's account row.
--    the fee exemption agent_key_suspended() returns false for an owner.
--
--  WHY A LEDGER AND NOT count(*) FROM houses
--  Because deleting a listing must not refund a slot. Counting live rows makes
--  the allowance mean "three at a time", and three at a time with a delete
--  button is unlimited posting with extra steps. The ledger row outlives the
--  listing, which is what makes "three posts in six months" true.
--
--  WHY THE UPDATE PATH IS NOT A HOLE
--  Editing a listing is free and always will be: it is the same room, with a
--  better photograph. What must not happen is an edit that quietly becomes a
--  post. The database side of that is simple, because only INSERT is counted
--  and only INSERT sets posted_by_owner -- an UPDATE cannot manufacture either
--  one, and a BEFORE UPDATE trigger pins the flag so a client cannot set it on
--  a row of its own. The screen side of it is in js/pages/agent-houses.js: the
--  form refuses to save when it was opened to edit and lost the id it was
--  editing, rather than falling through to an insert.
--
--  WHY CLAIMING "OWNER" IS NOT A WAY OUT OF THE FEE
--  Anyone may claim the owner kind, once, and the claim is refused for an
--  account that is already trading like an agent: one with an agent storefront,
--  or with more listings standing than the allowance would ever have let it
--  post. An admin can set the kind for anybody, which is the door for the
--  cases a rule should not try to guess at.
--
--  And in the other direction there is nothing to guard: an owner who wants
--  more than three posts in six months may become an agent whenever they like,
--  and an agent pays the fee and waits for approval. The two rules hold each
--  other up.
--
--  Idempotent. Safe to re-run. Depends on app_uid(), is_admin(), app_is_guest()
--  (p_message_guests.sql), houses/trucks/services, and agent_billing_setup.sql.
--  Run it AFTER agent_billing_setup.sql: it redefines agent_key_suspended, so
--  re-running that file would put the fee back on every owner.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. What kind of account this is, on the server
-- ---------------------------------------------------------------------------
-- The same four words login-doors.js uses, so there is one vocabulary and not
-- a second one that has to be kept in step. 'agent' is not stored by anybody
-- in practice, because an account with no row here is already treated as an
-- agent: that is the behaviour every existing account has today, and a new
-- table must not change what happens to accounts that are not in it.
create table if not exists public.account_kinds (
  user_id text primary key,
  kind    text not null check (kind in ('agent', 'owner', 'company', 'user')),
  set_at  timestamptz not null default now(),
  -- 'self' or an admin's id. Worth keeping: "how did this account stop paying"
  -- is a question somebody will ask one day, and the answer should not be a
  -- guess.
  set_by  text not null default 'self'
);

alter table public.account_kinds enable row level security;

drop policy if exists "account_kinds self read"  on public.account_kinds;
drop policy if exists "account_kinds admin all"  on public.account_kinds;

-- Your own row, and nobody else's. What kind of account somebody keeps is not
-- public information; the one fact the public needs is on the listing itself
-- (posted_by_owner), where it belongs.
create policy "account_kinds self read" on public.account_kinds for select
  using (user_id = (select public.app_uid()) or (select public.is_admin()));

create policy "account_kinds admin all" on public.account_kinds for all
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- Reading somebody else's kind, for the triggers and the fee gate, which have
-- to answer for accounts that are not the caller.
create or replace function public.account_kind(p_uid text)
  returns text
  language sql
  stable
  security definer
  set search_path = public
as $$
  select coalesce(
    (select k.kind from public.account_kinds k where k.user_id = p_uid),
    'agent');
$$;

create or replace function public.is_owner_account(p_uid text)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public
as $$
  select coalesce(p_uid, '') <> '' and public.account_kind(p_uid) = 'owner';
$$;

-- ---------------------------------------------------------------------------
-- 2. The allowance
-- ---------------------------------------------------------------------------
-- Two functions rather than two literals scattered through four triggers and
-- an RPC. Changing "three posts in six months" to any other pair of numbers is
-- meant to be one edit, and the screen reads these same two so the sentence a
-- landlord sees can never disagree with the rule that stops them.
create or replace function public.owner_post_limit()
  returns int language sql immutable set search_path = public as $$ select 3; $$;

create or replace function public.owner_post_window()
  returns interval language sql immutable set search_path = public as $$ select interval '180 days'; $$;

-- ---------------------------------------------------------------------------
-- 3. The ledger
-- ---------------------------------------------------------------------------
-- One row per listing an owner account has created. No foreign key to the
-- listing on purpose: the whole point is that it survives the listing being
-- deleted, and a cascade would take the record of the post away with it.
create table if not exists public.owner_posts (
  id        bigint generated by default as identity primary key,
  user_id   text not null,
  kind      text not null check (kind in ('house', 'truck', 'service')),
  item_id   text,
  posted_at timestamptz not null default now()
);

create index if not exists owner_posts_user_idx on public.owner_posts (user_id, posted_at desc);

alter table public.owner_posts enable row level security;

drop policy if exists "owner_posts self read" on public.owner_posts;
drop policy if exists "owner_posts admin all" on public.owner_posts;

create policy "owner_posts self read" on public.owner_posts for select
  using (user_id = (select public.app_uid()) or (select public.is_admin()));

-- No insert policy for anybody. The ledger is written by the trigger below,
-- which is SECURITY DEFINER: a row a client could write is a row a client
-- could not write.
create policy "owner_posts admin all" on public.owner_posts for all
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- How much of the allowance is left, and when the next slot frees.
-- Returned as one jsonb because the screen draws all of it at once, and two
-- round trips to say one sentence is one too many.
create or replace function public.owner_post_quota(p_uid text default null)
  returns jsonb
  language plpgsql
  stable
  security definer
  set search_path = public
as $fn$
declare
  v_uid    text := coalesce(p_uid, public.app_uid());
  v_limit  int  := public.owner_post_limit();
  v_win    interval := public.owner_post_window();
  v_used   int;
  v_oldest timestamptz;
begin
  if v_uid is null then
    raise exception 'Sign in first';
  end if;
  -- Somebody else's allowance is an admin's business and nobody else's.
  if v_uid <> coalesce(public.app_uid(), '') and not public.is_admin() then
    raise exception 'That is not your account';
  end if;

  select count(*)::int, min(p.posted_at)
    into v_used, v_oldest
    from public.owner_posts p
   where p.user_id = v_uid and p.posted_at > now() - v_win;

  return jsonb_build_object(
    'kind',        public.account_kind(v_uid),
    'is_owner',    public.is_owner_account(v_uid),
    'limit',       v_limit,
    'used',        v_used,
    'left',        greatest(0, v_limit - v_used),
    'window_days', extract(day from v_win)::int,
    -- The moment the oldest post in the window falls out of it, which is when
    -- a landlord at their ceiling gets a slot back. Null when they are not at
    -- the ceiling, because a date on a screen implies a wait that is not there.
    'next_free_at', case when v_used >= v_limit then v_oldest + v_win else null end);
end $fn$;

-- ---------------------------------------------------------------------------
-- 4. Claiming the kind
-- ---------------------------------------------------------------------------
-- The screen calls this once, at sign-up, straight after the door is chosen,
-- and again on the account page for anybody who signed up before this existed.
-- It is deliberately not a general "set my account type": claiming 'owner' is
-- claiming an exemption from the fee, so that one claim is checked and the
-- others are not.
create or replace function public.account_kind_claim(p_kind text)
  returns text
  language plpgsql
  security definer
  set search_path = public
as $fn$
declare
  v_uid  text := public.app_uid();
  v_have text;
  v_live int;
begin
  if v_uid is null then
    raise exception 'Sign in first';
  end if;

  -- A guest session is a browser tab. It cannot own a house, and it cannot be
  -- signed into again to answer for one.
  if public.app_is_guest() then
    raise exception 'Create an account first. A guest session cannot list a property';
  end if;

  if p_kind is null or p_kind not in ('agent', 'owner', 'company', 'user') then
    raise exception 'That is not one of the four kinds of account';
  end if;

  select k.kind into v_have from public.account_kinds k where k.user_id = v_uid;

  -- Already what you are asking to be. Not an error: the screen calls this
  -- every time the account page opens, so it can correct an account that
  -- predates the table.
  if v_have = p_kind then
    return v_have;
  end if;

  if p_kind = 'owner' then
    -- An agent with a storefront is trading as an agent, whatever they tap.
    if exists (select 1 from public.agent_profiles ap where ap.user_id = v_uid) then
      raise exception 'This account already has an agent page. Ask us to move it to an owner account';
    end if;
    -- And so is an account already holding more listings than the allowance
    -- would ever have let an owner post. This is the honest version of the
    -- rule: it looks at what the account has DONE, not at what it says it is.
    select (select count(*) from public.houses   h where h.owner_user_id = v_uid)
         + (select count(*) from public.trucks   t where t.owner_user_id = v_uid)
         + (select count(*) from public.services s where s.owner_user_id = v_uid)
      into v_live;
    if v_live > public.owner_post_limit() then
      raise exception 'This account already lists % properties, which is more than an owner account may post. Ask us to move it', v_live;
    end if;
  end if;

  insert into public.account_kinds (user_id, kind, set_by)
  values (v_uid, p_kind, 'self')
  on conflict (user_id) do update
    set kind = excluded.kind, set_at = now(), set_by = 'self';

  return p_kind;
end $fn$;

-- An admin can set anybody's, including the cases the rule above refuses.
create or replace function public.account_kind_set(p_uid text, p_kind text)
  returns text
  language plpgsql
  security definer
  set search_path = public
as $fn$
begin
  if not public.is_admin() then
    raise exception 'Admins only';
  end if;
  if p_kind is null or p_kind not in ('agent', 'owner', 'company', 'user') then
    raise exception 'That is not one of the four kinds of account';
  end if;
  insert into public.account_kinds (user_id, kind, set_by)
  values (p_uid, p_kind, coalesce(public.app_uid(), 'admin'))
  on conflict (user_id) do update
    set kind = excluded.kind, set_at = now(), set_by = excluded.set_by;
  return p_kind;
end $fn$;

-- ---------------------------------------------------------------------------
-- 5. The flag a card can read
-- ---------------------------------------------------------------------------
-- Denormalised onto the listing, and set by the trigger below rather than by
-- whoever is posting. Two reasons, and the second is the one that matters:
--
--   · a card would otherwise have to join account_kinds, and account_kinds is
--     readable only by its own account. Making it world-readable to draw one
--     badge would publish what kind of account every person on the site keeps.
--   · a column the client writes is a badge the client can award itself.
alter table public.houses add column if not exists posted_by_owner boolean not null default false;

create index if not exists houses_posted_by_owner_idx
  on public.houses (posted_by_owner) where posted_by_owner;

-- ---------------------------------------------------------------------------
-- 6. The gate on posting
-- ---------------------------------------------------------------------------
-- One trigger function for all three catalogues. The allowance is shared
-- across them on purpose: it is three POSTS, not three of each. An owner
-- account that could post three houses, three trucks and three services for
-- nothing would be an agent paying nothing, which is the hole this whole file
-- is here to close.
create or replace function public.owner_post_gate()
  returns trigger
  language plpgsql
  security definer
  set search_path = public
as $fn$
declare
  v_kind  text := tg_argv[0];
  v_owner text := new.owner_user_id;
  v_used  int;
  v_limit int := public.owner_post_limit();
begin
  -- Houses carry the flag. It is set here and only here, so a client sending
  -- posted_by_owner:true with its insert gets it overwritten with the truth.
  --
  -- And an owner's listing carries no agent fee, because there is no agent on
  -- it. agent_fee_tzs is the commission a renter pays the broker, usually a
  -- month's rent; on a listing with no broker it is zero, and forcing it here
  -- rather than trusting the form is what makes "no agent fees" a fact about
  -- the row instead of a claim on a card.
  if v_kind = 'house' then
    new.posted_by_owner := public.is_owner_account(v_owner);
    if new.posted_by_owner then new.agent_fee_tzs := 0; end if;
  end if;

  if not public.is_owner_account(v_owner) then
    return new;
  end if;

  -- An admin posting on somebody's behalf is doing support, not trading.
  if public.is_admin() then
    return new;
  end if;

  select count(*)::int into v_used
    from public.owner_posts p
   where p.user_id = v_owner
     and p.posted_at > now() - public.owner_post_window();

  if v_used >= v_limit then
    raise exception 'An owner account can post % listings every % days, and this account has used all %. The next one frees up on %',
      v_limit,
      extract(day from public.owner_post_window())::int,
      v_limit,
      to_char((select min(p.posted_at) from public.owner_posts p
                where p.user_id = v_owner
                  and p.posted_at > now() - public.owner_post_window())
              + public.owner_post_window(), 'FMDD Mon YYYY');
  end if;

  -- Counted at the moment it is allowed, in the same transaction as the
  -- listing: if the insert fails after this point the ledger row goes with it,
  -- and if it succeeds there is no window in which the post exists uncounted.
  insert into public.owner_posts (user_id, kind, item_id)
  values (v_owner, v_kind, new.id::text);

  return new;
end $fn$;

drop trigger if exists houses_owner_post_gate   on public.houses;
drop trigger if exists trucks_owner_post_gate   on public.trucks;
drop trigger if exists services_owner_post_gate on public.services;

create trigger houses_owner_post_gate
  before insert on public.houses
  for each row execute function public.owner_post_gate('house');

create trigger trucks_owner_post_gate
  before insert on public.trucks
  for each row execute function public.owner_post_gate('truck');

create trigger services_owner_post_gate
  before insert on public.services
  for each row execute function public.owner_post_gate('service');

-- The flag is a fact about how the listing was posted, so it does not change
-- afterwards. Without this, "houses owner update" -- which lets an account
-- write any column of its own row -- is a badge anybody can award themselves
-- with one request.
create or replace function public.houses_hold_owner_flag()
  returns trigger
  language plpgsql
  security definer
  set search_path = public
as $fn$
begin
  new.posted_by_owner := old.posted_by_owner;
  -- The fee follows the flag for the same reason: a listing that went up with
  -- no agent on it does not grow one on the next edit.
  if new.posted_by_owner then new.agent_fee_tzs := 0; end if;
  return new;
end $fn$;

drop trigger if exists houses_hold_owner_flag on public.houses;
create trigger houses_hold_owner_flag
  before update on public.houses
  for each row execute function public.houses_hold_owner_flag();

-- ---------------------------------------------------------------------------
-- 7. No fee, which is what the door promised
-- ---------------------------------------------------------------------------
-- agent_key_suspended() is the predicate behind every listing SELECT policy:
-- it hides a poster's listings once the 7-day approval window closes without
-- an admin, or once the monthly payment lapses. An owner account is subject to
-- neither, so the answer for one is simply "no".
--
-- Redefined here rather than edited in agent_billing_setup.sql, following the
-- layering the message files use: each file adds what it needs and the last to
-- run wins. The body below is that file's, unchanged, with one clause in front
-- of it. Run this file after it.
create or replace function public.agent_key_suspended(p_key text)
returns boolean language plpgsql stable security definer set search_path = public as $fn$
declare
  r        public.agent_billing%rowtype;
  v_found  boolean;
  v_reg    timestamptz;
  v_window interval := interval '7 days';
begin
  if p_key is null or p_key = '' then return false; end if;

  -- THE OWNER EXEMPTION. Only uid: keys can carry one: a 'ph:' key is a phone
  -- number off an agent's own listing and names no account to look up.
  if p_key like 'uid:%' and public.is_owner_account(substring(p_key from 5)) then
    return false;
  end if;

  select * into r from public.agent_billing b where b.agent_key = p_key;
  v_found := found;

  if v_found then
    if r.active is false then return true; end if;                 -- admin deactivated
    if r.status in ('cancelled','overdue') then return true; end if;
  end if;

  -- Approval gate (applies until an admin approves).
  if not (v_found and r.approved_at is not null) then
    v_reg := public.agent_registered_at(p_key);
    if v_reg is null then return false; end if;        -- unknown registration → don't lock out
    return now() > v_reg + v_window;                   -- live 7 days, then pause
  end if;

  -- Approved → normal billing.
  if r.paid_until is not null then
    return r.paid_until < current_date;                -- lapsed?
  end if;
  return false;                                        -- approved, no expiry → active
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 8. A guest may write to an owner, not only to an agent
-- ---------------------------------------------------------------------------
-- An owner account has no agent_profiles row, and pm_publish_key reads exactly
-- that row to decide pm_keys.is_agent. So the moment owners stopped being
-- agents, they stopped being reachable by the people most likely to want them:
-- p_message_guests.sql lets a guest open a conversation only with an agent.
--
-- That rule is right and stays. Its reason is written in that file: two
-- unidentified parties messaging each other is a free channel between two
-- people nobody has vouched for, which is a spam network with our name on it.
-- An owner is not that. They are a named account with a property on the board,
-- and the whole point of the VIP door is that a renter reaches them directly.
--
-- Everything else about the function is unchanged, including the five-new-
-- threads-an-hour ceiling, which is the part that actually stops the spam.
--
-- Redefined here, so run this file after p_message_guests.sql.
create or replace function public.pm_start_direct(p_other text)
  returns uuid
  language plpgsql
  security definer
  set search_path = public
as $fn$
declare
  v_uid    text := public.app_uid();
  v_guest  boolean := public.app_is_guest();
  v_id     uuid;
  v_recent int;
begin
  if v_uid is null then raise exception 'Sign in first'; end if;
  if p_other is null or p_other = v_uid then raise exception 'Pick someone else'; end if;
  if not exists (select 1 from public.pm_keys where user_id = p_other) then
    raise exception 'That person has not set up P-Message yet';
  end if;

  if v_guest then
    -- An agent, or the owner of a property. Not another guest.
    if not exists (select 1 from public.pm_keys where user_id = p_other and is_agent)
       and not public.is_owner_account(p_other) then
      raise exception 'Guests can only message agents and house owners. Sign in to message anyone.';
    end if;
    -- And a limited number of new threads per hour, which is the ceiling that
    -- does the real work against a flood.
    select count(*) into v_recent
    from public.pm_threads t
    where t.created_by = v_uid and t.created_at > now() - interval '1 hour';
    if v_recent >= 5 then
      raise exception 'Too many new conversations in one hour. Try again later, or sign in.';
    end if;
  end if;

  select t.id into v_id
  from public.pm_threads t
  where t.kind = 'direct'
    and exists (select 1 from public.pm_members m where m.thread_id = t.id and m.user_id = v_uid)
    and exists (select 1 from public.pm_members m where m.thread_id = t.id and m.user_id = p_other)
    and (select count(*) from public.pm_members m where m.thread_id = t.id) = 2
  limit 1;

  if v_id is not null then return v_id; end if;

  insert into public.pm_threads (kind, created_by) values ('direct', v_uid) returning id into v_id;
  insert into public.pm_members (thread_id, user_id, role) values
    (v_id, v_uid, 'owner'), (v_id, p_other, 'member');
  return v_id;
end $fn$;

-- ---------------------------------------------------------------------------
-- 9. Grants
-- ---------------------------------------------------------------------------
grant execute on function public.account_kind(text)         to anon, authenticated;
grant execute on function public.is_owner_account(text)     to anon, authenticated;
grant execute on function public.owner_post_limit()         to anon, authenticated;
grant execute on function public.owner_post_window()        to anon, authenticated;
grant execute on function public.owner_post_quota(text)     to anon, authenticated;
grant execute on function public.account_kind_claim(text)   to anon, authenticated;
grant execute on function public.account_kind_set(text, text) to authenticated;
grant select on public.account_kinds to anon, authenticated;
grant select on public.owner_posts   to anon, authenticated;
grant execute on function public.pm_start_direct(text) to anon, authenticated;

commit;
