-- ============================================================================
-- loc_share.sql — "give someone a code, they get the pin".
--
-- WHAT THIS IS FOR
-- Somebody is standing at a house, a shop or a meeting point. An agent, maybe
-- in another town, needs that exact spot on their map. Today the only route is
-- the agent sending a LINK (share-location.html?c=…) and the person opening it
-- — which needs the person to have a smartphone, data, and the link. This adds
-- the other direction: the person at the place mints a nine-character code and
-- reads it down the phone; the agent types it and the pin drops.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE CODE:  K7M-2Q9-F3T   (9 Crockford Base32 characters, shown in 3 groups)
--
--   chars 1-5   LOCATOR — a keyed permutation of a sequence counter. Minted
--               here, on the server.
--   chars 6-8   SECRET  — 15 random bits generated in the sender's BROWSER.
--               This half never reaches the server in any form, which is what
--               keeps the coordinates unreadable to us (see below).
--   char  9     CHECK   — a parity symbol over GF(2^5). Not security; it makes
--               a mistyped code fail instantly, in the hand, before any
--               request. See js/lib/loc-code.js for the proof.
--
-- WHY A PERMUTATION AND NOT A RANDOM STRING
-- js/pages/agent-houses.js mints its meet codes with Math.random() over 32^6.
-- By the birthday bound two of those collide after roughly 33,000 codes — and
-- a collision there silently hands one person another person's room. The usual
-- patch is "generate, check the table, retry on conflict", which races under
-- concurrency and gets slower as the table fills.
--
-- There is an exact answer instead. Take n from a sequence — unique by
-- construction, no race, no retry — and push it through a FEISTEL NETWORK:
--
--     a := a XOR F(key, 1, b)      a is 13 bits, b is 12 bits
--     b := b XOR F(key, 2, a)
--     a := a XOR F(key, 3, b)
--     b := b XOR F(key, 4, a)
--
-- Each round changes one half using only the other half, so each round is its
-- own inverse and the whole thing is a BIJECTION on 25 bits — for ANY F, which
-- is the point: the guarantee is structural, not probabilistic. Distinct n can
-- never produce the same locator. Not "almost never". Never.
--
-- F is HMAC-SHA256 under a key nobody outside this database has, so the output
-- order is unrelated to the input order: consecutive shares get locators with
-- nothing in common, and a locator reveals nothing about how many exist.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THE DATABASE CAN AND CANNOT SEE  (say this exactly; do not round it up)
--
-- Stored per share:  hmac(pepper, handle) · ciphertext · IV · an expiry · a
-- use count · a revoke hash. That is all. No coordinates, no locator, no code,
-- no creator id.
--
--   handle = HKDF(PBKDF2-SHA256(code, 210k), "handle")   — computed in the
--            browser, so the server sees a hash, never a code
--   key    = HKDF(PBKDF2-SHA256(code, 210k), "key")      — never sent anywhere
--
-- CAN be seen with the loc_shares table alone: nothing. Every row is opaque.
-- CANNOT be claimed: that a full compromise of this database is survivable.
-- An attacker holding BOTH the dump AND loc_share_secrets can grind the 2^40
-- code space at 210,000 PBKDF2 rounds a candidate — call it 2^57 hashes for
-- the whole table, weeks of serious GPU time, not centuries. The pepper lives
-- in its own locked table to make the dump-only case worthless; moving it into
-- Supabase Vault is the next hardening step and has not been taken yet.
--
-- Guessing from outside, which is the threat that actually matters: 2^40 is
-- 1.1 trillion, only 1 in 32 strings even passes the check symbol, opening
-- requires a signed-in non-guest account, and ten misses in an hour stops that
-- account. A share defaults to one open and thirty minutes.
--
-- Idempotent and transactional. Safe to re-run.
--   node scripts/db/apply_sql.mjs supabase/features/location/loc_share.sql
-- ============================================================================
begin;

-- ---------------------------------------------------------------- secrets ---
-- The Feistel key and the handle pepper. Their own table so that a leak of
-- loc_shares — a backup, a mis-scoped grant, a support export — is not enough
-- to attack the codes. RLS on with zero policies; only the SECURITY DEFINER
-- functions below, which run as the owner, can read it.
create table if not exists public.loc_share_secrets (
  id          smallint primary key default 1 check (id = 1),
  feistel_key bytea not null,
  pepper      bytea not null,
  created_at  timestamptz not null default now()
);

insert into public.loc_share_secrets (id, feistel_key, pepper)
select 1, extensions.gen_random_bytes(32), extensions.gen_random_bytes(32)
where not exists (select 1 from public.loc_share_secrets where id = 1);

-- ---------------------------------------------------------------- storage ---
-- 2^25 = 33,554,432 locators. At a thousand shares a day that is ninety years;
-- loc_share_ticket() refuses to mint past the end rather than wrapping, because
-- a wrapped sequence is exactly the duplicate this whole design exists to
-- prevent.
create sequence if not exists public.loc_share_seq as bigint start 1 increment 1 no cycle;

create table if not exists public.loc_shares (
  handle_pep     bytea primary key,          -- hmac(pepper, client handle)
  cipher         text not null,              -- AES-256-GCM, base64url
  iv             text not null,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  max_opens      integer not null,
  opens          integer not null default 0,
  revoked        boolean not null default false,
  revoke_hash    bytea not null,             -- sha256 of a token only the sender holds
  last_opened_at timestamptz
);
create index if not exists loc_shares_expires_idx on public.loc_shares (expires_at);

-- A ticket is a numbered slip: it carries one locator and can be spent once.
-- Without it a client could reuse a locator across many shares, and two codes
-- sharing five characters would drop an attacker's search from 2^40 to 2^15.
create table if not exists public.loc_share_tickets (
  ticket_hash bytea primary key,
  issued_at   timestamptz not null default now(),
  used_at     timestamptz
);
create index if not exists loc_share_tickets_issued_idx on public.loc_share_tickets (issued_at);

-- Wrong codes, by account and hour. Holds no location and no code — only the
-- fact that somebody typed something that did not exist.
create table if not exists public.loc_share_misses (
  id        bigserial primary key,
  user_id   text not null,
  missed_at timestamptz not null default now()
);
create index if not exists loc_share_misses_idx on public.loc_share_misses (user_id, missed_at);

-- ------------------------------------------------------------ the maths -----
-- A 4-round unbalanced Feistel network on 25 bits (13 | 12).
-- Immutable and key-taking, so it is a pure function of its arguments.
create or replace function public.loc_feistel25(p_n bigint, p_key bytea)
returns bigint
language plpgsql immutable strict
as $fn$
declare
  a int := ((p_n >> 12) & 8191)::int;   -- high 13 bits
  b int := (p_n & 4095)::int;           -- low  12 bits
  h bytea; v int; r int;
begin
  for r in 1..4 loop
    if r % 2 = 1 then
      h := extensions.hmac(convert_to(r::text || ':' || b::text, 'utf8'), p_key, 'sha256');
      v := (get_byte(h, 0) << 8) | get_byte(h, 1);
      a := a # (v & 8191);
    else
      h := extensions.hmac(convert_to(r::text || ':' || a::text, 'utf8'), p_key, 'sha256');
      v := (get_byte(h, 0) << 8) | get_byte(h, 1);
      b := b # (v & 4095);
    end if;
  end loop;
  return (a::bigint << 12) | b::bigint;
end $fn$;

-- Crockford Base32: no I, no L, no O, no U. Nothing in it can be misheard as
-- a digit down a phone line, and no three of them spell anything unfortunate.
create or replace function public.loc_b32(p_v bigint, p_chars int)
returns text
language sql immutable strict
as $fn$
  select string_agg(
           substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ', (((p_v >> (5 * i)) & 31)::int) + 1, 1),
           '' order by i desc)
  from generate_series(0, p_chars - 1) as g(i)
$fn$;

-- ------------------------------------------------------------- mint a slip --
create or replace function public.loc_share_ticket()
returns table (locator text, ticket text)
language plpgsql security definer set search_path = public, extensions
as $fn$
declare
  s public.loc_share_secrets%rowtype;
  n bigint; lv bigint; exp_at bigint; body text;
begin
  -- Anonymous callers are allowed to mint — the person at the house often has
  -- no account, and that is the whole use case. So the only brake that can
  -- exist is a global one, sized to be invisible to real use and to make
  -- burning the sequence take months rather than an afternoon.
  if (select count(*) from public.loc_share_tickets
      where issued_at > now() - interval '1 minute') > 300 then
    raise exception 'LOC_BUSY';
  end if;

  select * into s from public.loc_share_secrets where id = 1;
  if s.feistel_key is null then raise exception 'LOC_UNCONFIGURED'; end if;

  n := nextval('public.loc_share_seq');
  if n > 33554431 then raise exception 'LOC_EXHAUSTED'; end if;

  lv      := public.loc_feistel25(n, s.feistel_key);
  locator := public.loc_b32(lv, 5);
  exp_at  := extract(epoch from now())::bigint + 600;   -- a slip is good for 10 minutes
  body    := locator || '.' || exp_at::text;
  ticket  := body || '.' ||
             encode(extensions.hmac(convert_to(body, 'utf8'), s.feistel_key, 'sha256'), 'hex');

  insert into public.loc_share_tickets (ticket_hash)
    values (extensions.digest(convert_to(ticket, 'utf8'), 'sha256'));
  return next;
end $fn$;

-- ------------------------------------------------------------ store a share --
-- The browser has already chosen the last three characters, built the code,
-- derived the handle and encrypted the coordinates. Nothing here can read any
-- of that, and that is deliberate.
create or replace function public.loc_share_create(
  p_ticket      text,
  p_handle      text,          -- 64 hex chars
  p_cipher      text,
  p_iv          text,
  p_ttl_minutes integer default 30,
  p_max_opens   integer default 1,
  p_revoke_hash text default null   -- 64 hex chars
) returns table (expires_at timestamptz)
language plpgsql security definer set search_path = public, extensions
as $fn$
declare
  s public.loc_share_secrets%rowtype;
  parts text[]; body text; exp_at bigint; th bytea;
  ttl int; opens_cap int;
begin
  if p_handle      !~ '^[0-9a-f]{64}$' then raise exception 'LOC_BAD_HANDLE'; end if;
  if p_revoke_hash !~ '^[0-9a-f]{64}$' then raise exception 'LOC_BAD_REVOKE'; end if;
  if p_cipher is null or length(p_cipher) > 4000 then raise exception 'LOC_BAD_CIPHER'; end if;
  if p_iv is null or length(p_iv) > 64           then raise exception 'LOC_BAD_IV'; end if;

  select * into s from public.loc_share_secrets where id = 1;

  -- Spend the slip: right shape, our signature, still fresh, never used.
  parts := string_to_array(coalesce(p_ticket, ''), '.');
  if array_length(parts, 1) <> 3 then raise exception 'LOC_BAD_TICKET'; end if;
  body   := parts[1] || '.' || parts[2];
  exp_at := parts[2]::bigint;
  if encode(extensions.hmac(convert_to(body, 'utf8'), s.feistel_key, 'sha256'), 'hex') <> parts[3]
    then raise exception 'LOC_BAD_TICKET'; end if;
  if exp_at < extract(epoch from now())::bigint then raise exception 'LOC_TICKET_EXPIRED'; end if;

  th := extensions.digest(convert_to(p_ticket, 'utf8'), 'sha256');
  update public.loc_share_tickets set used_at = now()
    where ticket_hash = th and used_at is null;
  if not found then raise exception 'LOC_TICKET_SPENT'; end if;

  ttl       := least(greatest(coalesce(p_ttl_minutes, 30), 5), 1440);
  opens_cap := least(greatest(coalesce(p_max_opens, 1), 1), 50);

  insert into public.loc_shares (handle_pep, cipher, iv, expires_at, max_opens, revoke_hash)
  values (
    extensions.hmac(decode(p_handle, 'hex'), s.pepper, 'sha256'),
    p_cipher, p_iv, now() + make_interval(mins => ttl), opens_cap,
    decode(p_revoke_hash, 'hex')
  );

  -- Sweep occasionally rather than on a schedule: there is no pg_cron here, and
  -- an expired share that lingers is a row nobody can read but everybody pays
  -- to back up.
  if random() < 0.02 then perform public.loc_share_gc(); end if;

  expires_at := now() + make_interval(mins => ttl);
  return next;
end $fn$;

-- -------------------------------------------------------------- open a code --
-- Returns a STATUS rather than raising, because a raise rolls back the whole
-- function — including the miss we just recorded. A fence that forgets every
-- wrong attempt is not a fence.
create or replace function public.loc_share_open(p_handle text)
returns table (status text, cipher text, iv text,
               expires_at timestamptz, opens integer, max_opens integer)
language plpgsql security definer set search_path = public, extensions
as $fn$
declare
  s public.loc_share_secrets%rowtype;
  row_ public.loc_shares%rowtype;
  uid text := public.app_uid();
  misses int;
begin
  status := 'forbidden'; cipher := null; iv := null;
  expires_at := null; opens := null; max_opens := null;

  -- Signing in is what makes the ten-misses-an-hour rule mean anything: an
  -- anonymous caller can be a new caller every request. Guests are anonymous
  -- accounts, so app_is_guest() is checked too — the same fence the catalogue
  -- uses.
  if uid is null or public.app_is_guest() then return next; return; end if;
  if p_handle !~ '^[0-9a-f]{64}$' then status := 'not_found'; return next; return; end if;

  select count(*) into misses from public.loc_share_misses
    where user_id = uid and missed_at > now() - interval '1 hour';
  if misses >= 10 then status := 'rate_limited'; return next; return; end if;

  select * into s from public.loc_share_secrets where id = 1;

  select * into row_ from public.loc_shares
    where handle_pep = extensions.hmac(decode(p_handle, 'hex'), s.pepper, 'sha256')
    for update;

  if not found then
    insert into public.loc_share_misses (user_id) values (uid);
    status := 'not_found'; return next; return;
  end if;

  -- A code that really exists but has run out is a different sentence to the
  -- person holding it, and it must not cost them one of their ten tries.
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

-- ------------------------------------------------- the sender's own controls --
-- Checking on a share and killing it are the same question — "is this still
-- mine and still out there?" — so they are one function with a flag. Proof of
-- ownership is a token that exists only in the sender's browser: whoever holds
-- the CODE can open the share, but only the device that made it can revoke it.
create or replace function public.loc_share_manage(
  p_handle text, p_revoke_token text, p_revoke boolean default false
) returns table (status text, opens integer, max_opens integer,
                 expires_at timestamptz, revoked boolean, last_opened_at timestamptz)
language plpgsql security definer set search_path = public, extensions
as $fn$
declare
  s public.loc_share_secrets%rowtype;
  row_ public.loc_shares%rowtype;
begin
  status := 'not_found';
  opens := null; max_opens := null; expires_at := null; revoked := null; last_opened_at := null;

  if p_handle !~ '^[0-9a-f]{64}$' then return next; return; end if;

  select * into s from public.loc_share_secrets where id = 1;
  select * into row_ from public.loc_shares
    where handle_pep = extensions.hmac(decode(p_handle, 'hex'), s.pepper, 'sha256')
    for update;
  if not found then return next; return; end if;

  if row_.revoke_hash is distinct from
     extensions.digest(convert_to(coalesce(p_revoke_token, ''), 'utf8'), 'sha256')
  then
    status := 'forbidden'; return next; return;
  end if;

  if p_revoke and not row_.revoked then
    -- Revoking throws the ciphertext away rather than flagging the row. A flag
    -- is a promise the database keeps; an empty column is a fact.
    update public.loc_shares ls
       set revoked = true, cipher = '', iv = ''
     where ls.handle_pep = row_.handle_pep;
    row_.revoked := true;
  end if;

  status := 'ok';
  opens := row_.opens; max_opens := row_.max_opens; expires_at := row_.expires_at;
  revoked := row_.revoked; last_opened_at := row_.last_opened_at;
  return next;
end $fn$;

-- ------------------------------------------------------------------- sweep ---
create or replace function public.loc_share_gc()
returns void
language sql security definer set search_path = public
as $fn$
  with a as (delete from public.loc_shares
              where expires_at < now() - interval '1 day' returning 1),
       b as (delete from public.loc_share_tickets
              where issued_at < now() - interval '1 hour' returning 1),
       c as (delete from public.loc_share_misses
              where missed_at < now() - interval '2 hours' returning 1)
  select null::void;
$fn$;

-- ------------------------------------------------------------------ locking --
-- Same shape as meet_secure.sql intended: RLS on, no policies, no table grants.
-- Everything goes through the functions above, which run as the owner.
alter table public.loc_share_secrets enable row level security;
alter table public.loc_shares        enable row level security;
alter table public.loc_share_tickets enable row level security;
alter table public.loc_share_misses  enable row level security;

revoke all on public.loc_share_secrets from anon, authenticated;
revoke all on public.loc_shares        from anon, authenticated;
revoke all on public.loc_share_tickets from anon, authenticated;
revoke all on public.loc_share_misses  from anon, authenticated;
revoke all on sequence public.loc_share_seq from anon, authenticated;

-- CREATE FUNCTION grants EXECUTE to PUBLIC by default, and both anon and
-- authenticated inherit that. Every function is therefore revoked from PUBLIC
-- first and then granted back deliberately — otherwise `grant execute ... to
-- authenticated` on loc_share_open reads like a fence while anon still holds a
-- key to the same door. (It answered 'forbidden' to anon regardless, because
-- app_uid() is null there. A fence that only works because of what is behind it
-- is not a fence.)
revoke all on function public.loc_feistel25(bigint, bytea) from public, anon, authenticated;
revoke all on function public.loc_b32(bigint, int)         from public, anon, authenticated;
revoke all on function public.loc_share_gc()               from public, anon, authenticated;
revoke all on function public.loc_share_ticket()           from public, anon, authenticated;
revoke all on function public.loc_share_create(text, text, text, text, integer, integer, text)
  from public, anon, authenticated;
revoke all on function public.loc_share_open(text)         from public, anon, authenticated;
revoke all on function public.loc_share_manage(text, text, boolean)
  from public, anon, authenticated;

grant execute on function public.loc_share_ticket() to anon, authenticated;
grant execute on function public.loc_share_create(text, text, text, text, integer, integer, text)
  to anon, authenticated;
-- Opening is the one that hands back a location, so it is the one that needs
-- an account behind it.
grant execute on function public.loc_share_open(text) to authenticated;
grant execute on function public.loc_share_manage(text, text, boolean) to anon, authenticated;

commit;
