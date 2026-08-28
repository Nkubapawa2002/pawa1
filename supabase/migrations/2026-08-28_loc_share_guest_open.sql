-- ============================================================================
--  A guest may open a location code.
--
--  WHAT WAS WRONG
--  loc_share_open() refused any anonymous account outright:
--
--      if uid is null or public.app_is_guest() then return 'forbidden'; end if;
--
--  P-Message's front door is the guest gate. "Message an agent without an
--  account" is the path most people arrive on, and it signs them in
--  anonymously, so app_is_guest() is true for the majority of the people who
--  are handed a code. Every one of them typed the nine characters and got
--  'forbidden' back — a status neither share-location.html nor p-message.html
--  had a sentence for, so both fell through to "that did not work", which is
--  advice to try again at something that could never succeed.
--
--  WHY THE FENCE EXISTED, AND WHY IT CANNOT SIMPLY GO
--  The ten-misses-an-hour rule is counted per account. A guest can mint a new
--  account per request, so per-account counting alone does not slow a guest
--  down at all. The code space is 2^40 (5 locator characters the server issues
--  and 3 the browser chooses); an attacker with unlimited identities and no
--  global brake would be metered only by the network.
--
--  WHAT REPLACES IT
--  A guest is metered by something a guest cannot rotate: a GLOBAL budget.
--
--    · a real account keeps its own 10 misses an hour, unchanged
--    · a guest account gets 3, which covers reading a code back wrong
--    · all guests together get 120 an hour, and that is the load-bearing one
--
--  120 an hour is about a million guesses a year against a space of 2^40. It
--  is invisible to somebody typing a code they were told, because only a WRONG
--  code costs anything: a correct one is not a miss and burns no budget.
--
--  The honest cost of this design, stated rather than hidden: someone can burn
--  the global guest budget deliberately and lock guests out for the rest of the
--  hour. Signed-in accounts are untouched when that happens, guests are told
--  what to do about it, and the window rolls on its own. Locking out the
--  people with no account is the right side to fail on.
--
--  Apply: Supabase SQL editor, or the PAT route in scripts/db/.
-- ============================================================================
begin;

-- A miss now records whether it came from an account or from a guest, because
-- the two are metered against different budgets. Existing rows are real
-- accounts by default, which is what they were.
alter table public.loc_share_misses
  add column if not exists is_guest boolean not null default false;

-- The global guest count is a scan over one hour of guest rows, so it is the
-- one that needs its own partial index.
create index if not exists loc_share_misses_guest_idx
  on public.loc_share_misses (missed_at) where is_guest;

create or replace function public.loc_share_open(p_handle text)
returns table (status text, cipher text, iv text,
               expires_at timestamptz, opens integer, max_opens integer)
language plpgsql security definer set search_path = public, extensions
as $fn$
declare
  s public.loc_share_secrets%rowtype;
  row_ public.loc_shares%rowtype;
  uid text := public.app_uid();
  guest boolean := public.app_is_guest();
  misses int;
  -- Named rather than sprinkled through the branches: these three numbers are
  -- the whole security argument and somebody tuning them should see them
  -- together.
  account_hourly constant int := 10;
  guest_hourly   constant int := 3;
  guests_hourly  constant int := 120;
begin
  status := 'forbidden'; cipher := null; iv := null;
  expires_at := null; opens := null; max_opens := null;

  -- Signed out entirely is still refused: there is no identity to meter, and
  -- the EXECUTE grant already stops it one layer earlier.
  if uid is null then return next; return; end if;
  if p_handle !~ '^[0-9a-f]{64}$' then status := 'not_found'; return next; return; end if;

  if guest then
    -- The global brake comes first. It is the only one an attacker holding a
    -- fresh account per request actually runs into.
    select count(*) into misses from public.loc_share_misses
      where is_guest and missed_at > now() - interval '1 hour';
    if misses >= guests_hourly then status := 'rate_limited'; return next; return; end if;

    select count(*) into misses from public.loc_share_misses
      where user_id = uid and missed_at > now() - interval '1 hour';
    if misses >= guest_hourly then status := 'rate_limited'; return next; return; end if;
  else
    select count(*) into misses from public.loc_share_misses
      where user_id = uid and missed_at > now() - interval '1 hour';
    if misses >= account_hourly then status := 'rate_limited'; return next; return; end if;
  end if;

  select * into s from public.loc_share_secrets where id = 1;

  select * into row_ from public.loc_shares
    where handle_pep = extensions.hmac(decode(p_handle, 'hex'), s.pepper, 'sha256')
    for update;

  if not found then
    insert into public.loc_share_misses (user_id, is_guest) values (uid, guest);
    status := 'not_found'; return next; return;
  end if;

  -- A code that really exists but has run out is a different sentence to the
  -- person holding it, and it must not cost them one of their tries.
  if row_.revoked                 then status := 'revoked'; return next; return; end if;
  if row_.expires_at <= now()     then status := 'expired'; return next; return; end if;
  if row_.opens >= row_.max_opens then status := 'used_up'; return next; return; end if;

  -- Aliased `ls`, and the right-hand side qualified: `opens` is also an OUT
  -- parameter of this function, and unqualified it resolves to the variable.
  -- The alias cannot be `s` — that name is already the secrets row above.
  update public.loc_shares ls
     set opens = ls.opens + 1, last_opened_at = now()
   where ls.handle_pep = row_.handle_pep;

  status := 'ok'; cipher := row_.cipher; iv := row_.iv;
  expires_at := row_.expires_at; opens := row_.opens + 1; max_opens := row_.max_opens;
  return next;
end $fn$;

-- CREATE OR REPLACE keeps the existing grants, but say it anyway so this file
-- is complete on its own.
revoke all on function public.loc_share_open(text) from public, anon;
grant execute on function public.loc_share_open(text) to authenticated;

commit;
