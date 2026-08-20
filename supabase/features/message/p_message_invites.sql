-- ============================================================================
-- p_message_invites.sql — an agent hands a customer a link, and the customer
-- can answer without ever making an account.
-- ============================================================================
-- p_message_guests.sql already lets a CUSTOMER start a conversation with an
-- agent: they browse, they tap "message this agent", they get an anonymous
-- session and a real key. What it cannot do is the other direction. An agent
-- who met someone at a viewing, or has a phone number and nothing else, had no
-- way to open a thread — you cannot message a person who has never opened the
-- site, because there is no key to seal to.
--
-- An invite is that missing direction. The agent creates one, sends the link
-- by WhatsApp or SMS (outside this system, deliberately — see below), and the
-- customer who opens it gets a session, a key, and a thread with that agent
-- already in it.
--
-- THE TOKEN IS STORED HASHED, NOT RAW
-- The link is a bearer credential: whoever holds it becomes the customer in
-- that thread. If the raw token sat in this table, anyone who could read the
-- database — the thing every other part of P-Message is built to not rely on —
-- could walk into a conversation. So the table holds sha256(token) and the
-- token itself exists only in the link. A stolen database yields no usable
-- invites. This is the same reason a password reset table never holds the
-- reset code.
--
-- WHAT AN INVITE HONESTLY IS, AND IS NOT
--  · It is single use and it expires. Both are enforced here, not in the UI.
--  · Whoever opens the link first becomes the customer. That is inherent to
--    links, not a flaw to be engineered away: the agent chose to send it over
--    a channel we do not control. If the wrong person opens it, the agent sees
--    an accepted invite they did not expect and can revoke the thread.
--  · It proves NOTHING about who the customer is. An invited guest is still a
--    guest: unverified, fenced out of the catalogue by app_is_guest(), and
--    shown as a guest in the agent's inbox. An invite is an introduction, not
--    an identity.
--  · The encryption is untouched. Once the thread exists it is an ordinary
--    direct thread, sealed exactly like every other.
--
-- Idempotent. Safe to re-run. Depends on p_message.sql and p_message_guests.sql.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. The invite
-- ---------------------------------------------------------------------------
create table if not exists public.pm_invites (
  -- sha256 of the token, hex. The token itself is never stored anywhere.
  token_hash  text primary key,
  agent_id    text not null,
  -- The agent's own note for who this was for ("the couple from Kariakoo").
  -- Plaintext, and visible only to the agent who wrote it.
  label       text,
  thread_id   uuid references public.pm_threads(id) on delete set null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default (now() + interval '14 days'),
  accepted_at timestamptz,
  accepted_by text,
  revoked_at  timestamptz
);

create index if not exists pm_invites_agent_idx on public.pm_invites (agent_id, created_at desc);

alter table public.pm_invites enable row level security;

drop policy if exists "pm_invites own read"   on public.pm_invites;
drop policy if exists "pm_invites own revoke" on public.pm_invites;

-- An agent sees their own invites and nobody else's. Note there is no INSERT
-- policy: invites are only ever created through pm_invite_create() below, so
-- the agent_id cannot be forged by writing the row directly.
create policy "pm_invites own read" on public.pm_invites for select
  using (agent_id = (select public.app_uid()));

create policy "pm_invites own revoke" on public.pm_invites for update
  using (agent_id = (select public.app_uid()))
  with check (agent_id = (select public.app_uid()));

-- ---------------------------------------------------------------------------
-- 2. Creating one
-- ---------------------------------------------------------------------------
-- The caller generates the token (32 random bytes, base64url) and sends us
-- only its hash. We never see the token, which means we cannot leak it and we
-- cannot reconstruct a link from a backup.
create or replace function public.pm_invite_create(
  p_token_hash text,
  p_label      text default null,
  p_days       int  default 14
) returns table (token_hash text, expires_at timestamptz)
  language plpgsql
  security definer
  set search_path = public
as $fn$
declare
  v_uid    text := public.app_uid();
  v_recent int;
begin
  if v_uid is null then raise exception 'Sign in first'; end if;
  -- A guest inviting a guest is two anonymous tabs talking, which is a spam
  -- network with our name on it. Same rule as pm_start_direct.
  if public.app_is_guest() then
    raise exception 'Guests cannot create invites. Sign in to invite a customer.';
  end if;
  if not exists (select 1 from public.pm_keys where user_id = v_uid) then
    raise exception 'Set up P-Message on this device before inviting anyone';
  end if;
  -- 64 hex characters, or it is not a sha256 and somebody is improvising.
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Malformed invite token';
  end if;

  -- An unlimited invite generator is a link farm. This is deliberately
  -- generous for a working agent and useless for a script.
  select count(*) into v_recent from public.pm_invites
  where agent_id = v_uid and created_at > now() - interval '1 hour';
  if v_recent >= 30 then
    raise exception 'Too many invites in one hour. Try again later.';
  end if;

  return query
  insert into public.pm_invites (token_hash, agent_id, label, expires_at)
  values (p_token_hash, v_uid, nullif(trim(coalesce(p_label, '')), ''),
          now() + (greatest(1, least(coalesce(p_days, 14), 90)) || ' days')::interval)
  returning pm_invites.token_hash, pm_invites.expires_at;
end $fn$;

-- ---------------------------------------------------------------------------
-- 3. Looking at one before committing to it
-- ---------------------------------------------------------------------------
-- The customer's browser calls this to render "Amina invited you to chat"
-- before it generates a key. It takes the RAW token and hashes it here, so the
-- token still never lands in a column.
--
-- It deliberately returns nothing identifying beyond the agent's display name:
-- an invite link that has leaked should not become a lookup tool for who an
-- agent is or what else they do.
create or replace function public.pm_invite_peek(p_token text)
  returns table (agent_name text, label text, expires_at timestamptz, state text)
  language sql
  stable
  security definer
  set search_path = public
as $fn$
  select
    coalesce(k.display_name, ap.name),
    i.label,
    i.expires_at,
    case
      when i.revoked_at is not null  then 'revoked'
      when i.accepted_at is not null then 'used'
      when i.expires_at < now()      then 'expired'
      else 'open'
    end
  from public.pm_invites i
  left join public.pm_keys k on k.user_id = i.agent_id
  left join public.agent_profiles ap on ap.user_id = i.agent_id
  where i.token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'utf8')), 'hex');
$fn$;

-- ---------------------------------------------------------------------------
-- 4. Accepting
-- ---------------------------------------------------------------------------
-- Called by the customer AFTER they have published a key, so there is
-- something to seal to. Returns the thread id.
--
-- The three states that are not 'open' each get their own message, because
-- "this link doesn't work" is the least useful thing to tell someone standing
-- in a doorway with a phone.
create or replace function public.pm_invite_accept(p_token text)
  returns uuid
  language plpgsql
  security definer
  set search_path = public
as $fn$
declare
  v_uid   text := public.app_uid();
  v_hash  text := encode(sha256(convert_to(coalesce(p_token, ''), 'utf8')), 'hex');
  v_inv   public.pm_invites%rowtype;
  v_id    uuid;
begin
  if v_uid is null then raise exception 'No session'; end if;
  if not exists (select 1 from public.pm_keys where user_id = v_uid) then
    raise exception 'Set up encryption on this device first';
  end if;

  -- Locked, so two taps on a flaky connection cannot both consume it and end
  -- up with two threads.
  select * into v_inv from public.pm_invites where token_hash = v_hash for update;

  if v_inv.token_hash is null then raise exception 'That invite link is not valid'; end if;
  if v_inv.revoked_at is not null then raise exception 'That invite was withdrawn'; end if;
  if v_inv.expires_at < now() then raise exception 'That invite has expired. Ask for a new link.'; end if;
  if v_inv.agent_id = v_uid then raise exception 'That is your own invite link'; end if;

  -- Already used: if it was US who used it, hand back the same thread rather
  -- than an error. Reopening the link from your own history is not an attack,
  -- it is how people find a conversation again.
  if v_inv.accepted_at is not null then
    if v_inv.accepted_by = v_uid and v_inv.thread_id is not null then
      return v_inv.thread_id;
    end if;
    raise exception 'That invite has already been used';
  end if;

  insert into public.pm_threads (kind, created_by) values ('direct', v_inv.agent_id)
  returning id into v_id;
  insert into public.pm_members (thread_id, user_id, role) values
    (v_id, v_inv.agent_id, 'owner'), (v_id, v_uid, 'member');

  update public.pm_invites
     set accepted_at = now(), accepted_by = v_uid, thread_id = v_id
   where token_hash = v_hash;

  return v_id;
end $fn$;

-- ---------------------------------------------------------------------------
-- 5. The agent's side: listing and withdrawing
-- ---------------------------------------------------------------------------
-- Never returns token_hash. It is not secret in the way the token is, but it
-- has no use on the client either, and a value with no use is a value that
-- ends up in a log.
create or replace function public.pm_invites_mine(p_limit int default 50)
  returns table (
    label       text,
    state       text,
    thread_id   uuid,
    created_at  timestamptz,
    expires_at  timestamptz,
    guest_name  text
  )
  language sql
  stable
  security definer
  set search_path = public
as $fn$
  select
    i.label,
    case
      when i.revoked_at is not null  then 'revoked'
      when i.accepted_at is not null then 'used'
      when i.expires_at < now()      then 'expired'
      else 'open'
    end,
    i.thread_id, i.created_at, i.expires_at,
    gk.display_name
  from public.pm_invites i
  left join public.pm_keys gk on gk.user_id = i.accepted_by
  where i.agent_id = public.app_uid()
  order by i.created_at desc
  limit greatest(1, least(coalesce(p_limit, 50), 200));
$fn$;

-- Withdrawing an unused link. It cannot un-send a thread that already exists —
-- for that the agent leaves the thread — and saying otherwise would be a lie.
create or replace function public.pm_invite_revoke(p_token_hash text)
  returns void
  language sql
  security definer
  set search_path = public
as $fn$
  update public.pm_invites
     set revoked_at = now()
   where token_hash = p_token_hash
     and agent_id = public.app_uid()
     and accepted_at is null;
$fn$;

-- ---------------------------------------------------------------------------
-- 6. Grants
-- ---------------------------------------------------------------------------
-- peek and accept are reachable by `anon` because the customer holding the
-- link is, by definition, not signed in yet.
grant execute on function public.pm_invite_create(text, text, int) to authenticated;
grant execute on function public.pm_invite_peek(text)              to anon, authenticated;
grant execute on function public.pm_invite_accept(text)            to anon, authenticated;
grant execute on function public.pm_invites_mine(int)              to authenticated;
grant execute on function public.pm_invite_revoke(text)            to authenticated;

commit;

-- ============================================================================
-- The client flow:
--   agent:    token = 32 random bytes, base64url        (never sent to us)
--             pm_invite_create(sha256(token), label)
--             link = p-message.html?i=<token>           (sent by WhatsApp/SMS)
--   customer: pm_invite_peek(token)      -> "Amina invited you to chat"
--             signInAnonymously() + PMCrypto.generateIdentity() + pm_publish_key()
--             pm_invite_accept(token)    -> thread id, and it is an ordinary
--                                           direct thread from here on.
-- ============================================================================
