-- ============================================================================
-- p_message_security.sql — closing the doors P-Message left open on the
-- tables themselves.
-- ============================================================================
-- Every earlier file in this feature reasoned carefully about what its RPCs
-- allow. None of them checked what the TABLES allow. PostgREST exposes every
-- table in `public` directly, Supabase grants anon and authenticated all four
-- DML privileges on them by default, and from there the only thing standing
-- between a request and a row is a row-level policy. P-Message shipped four
-- write policies. Three of them were wrong, and the fourth was wider than it
-- needed to be.
--
-- THE FOUR, IN THE ORDER THEY MATTER
--
-- 1. IDENTITY FORGERY — `pm_keys self write` / `pm_keys self update`.
--    Both check only `user_id = app_uid()`. Every other column was the
--    caller's to choose, and two of them are decisions the server is supposed
--    to make:
--
--      PATCH /rest/v1/pm_keys?user_id=eq.<me>
--      { "is_agent": true, "is_guest": false, "display_name": "Maisha Support" }
--
--    That request turns a browser tab with no email address into an entry in
--    the agent directory. It is not a cosmetic lie: `is_agent` is what
--    pm_start_direct checks to decide who a guest may write to, `is_guest` is
--    what pm_group_candidates and pm_recipients check to keep anonymous
--    sessions out of admin rooms and announcements, and `display_name` is the
--    only name anyone in a thread ever sees. One PATCH defeats all three, and
--    the fence in p_message_guests.sql — the file whose header says the two
--    halves are not separable — is walked around rather than through.
--
--    pm_publish_key() already derives all three correctly: the name and region
--    from agent_profiles, is_agent from having such a profile, is_guest from
--    the JWT claim. It is SECURITY DEFINER, so it does not need a policy. The
--    fix is therefore to delete both policies rather than to narrow them: a
--    table whose only writer is a function that gets it right does not need a
--    way in for callers who might not.
--
-- 2. ROOM TAKEOVER — `pm_members self update`.
--    Written for `last_read_at`, which is the one column a member legitimately
--    writes. It permits all of them, and one of the others is `role`:
--
--      PATCH /rest/v1/pm_members?thread_id=eq.<room>&user_id=eq.<me>
--      { "role": "owner" }
--
--    pm_group_add and pm_group_remove both authorise on exactly that string.
--    So any member of any room can promote themselves and then add anyone they
--    like to an encrypted room an admin opened, or empty it of everybody else.
--    They also become unremovable, because pm_group_remove deletes
--    `where role <> 'owner'` — the admin who opened the room cannot undo it.
--
--    pm_mark_read() is SECURITY DEFINER and is the only thing that ever wrote
--    `last_read_at`, so this policy had no legitimate caller at all.
--
-- 3. LEDGER REWRITE — `pm_invites own revoke`.
--    An invite is "single use and it expires. Both are enforced here, not in
--    the UI" (p_message_invites.sql). They are enforced by reading
--    `accepted_at` and `expires_at` — two columns this policy let the agent
--    write. {"accepted_at": null} makes a used link live again;
--    {"expires_at": "2099-01-01"} makes a link that never expires. Withdrawal
--    goes through pm_invite_revoke(), which is SECURITY DEFINER, so again the
--    policy had no caller.
--
-- 4. JUNK — `pm_threads insert self`.
--    Any signed-in caller could insert unlimited thread rows. Not an
--    escalation (they are not a member of what they create, so they cannot
--    read it either) but every real thread is created by pm_start_direct,
--    pm_broadcast, pm_group_create or pm_invite_accept, all SECURITY DEFINER.
--    Nothing legitimate loses anything.
--
-- AND ONE THAT IS NOT A POLICY
--
-- 5. ROTATION DEFEATED BY COUNTING UPWARDS — pm_send_sk / pm_sender_key_put.
--    p_message_sender_keys.sql calls its generation check "the load-bearing
--    line of this file", and it is off by a comparison operator:
--
--      if p_generation < v_gen then raise ...
--
--    It refuses a STALE generation. It accepts a generation from the future.
--    A client that distributes its sender key at generation 2147483647 once is
--    never stale again: every membership change bumps the thread from 3 to 4
--    to 5, the comparison stays false, and the person who was removed keeps
--    reading the room forever with the key they were handed on day one. The
--    rule the whole scheme rests on is "the key must match the membership it
--    was distributed to", and only equality says that.
--
-- WHAT IS ADDED RATHER THAN CLOSED
--
--   · A public key is checked for being one. Junk in that column makes the
--     owner permanently unwritable-to with no symptom on their own screen.
--   · Ciphertext has a ceiling. Without one, pm_send is free unbounded storage
--     for anyone holding the anon key and a guest session.
--   · Sending and starting conversations have rate limits for EVERYONE, not
--     only guests. pm_keys is enumerable by any signed-in caller by design —
--     it is a directory — so "message every user in the country" was a loop.
--
-- WHAT IS DELIBERATELY NOT DONE
--
--   · Admins still get no read policy on other people's threads. Ciphertext
--     they cannot open, and putting it in the schema would contradict the one
--     sentence this feature is built to be able to say.
--   · Nothing here weakens or reshapes the crypto. Not one byte of the wire
--     format changes; p_crypto_test.mjs is untouched by this file.
--
-- Idempotent. Safe to re-run. Depends on p_message.sql, _guests, _groups,
-- _invites and _sender_keys.
--
--   usage:  node scripts/db/apply_sql.mjs supabase/features/message/p_message_security.sql
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. pm_keys — the server decides who is an agent, and who is a guest
-- ---------------------------------------------------------------------------
drop policy if exists "pm_keys self write"  on public.pm_keys;
drop policy if exists "pm_keys self update" on public.pm_keys;

-- Reading stays open to anyone SIGNED IN, and closes to the bare anon key.
-- pm_directory() has always refused a signed-out caller, with a reason worth
-- repeating: "the names and operating areas of every agent in the country are
-- exactly the list a scraper with the public anon key would want". The table
-- underneath it answered that same query to the same scraper, one level down.
-- A guest counts as signed in; what is shut out is nobody at all.
drop policy if exists "pm_keys readable" on public.pm_keys;
create policy "pm_keys readable" on public.pm_keys for select
  using ((select public.app_uid()) is not null);

-- ---------------------------------------------------------------------------
-- 2. pm_members — nobody writes their own role
-- ---------------------------------------------------------------------------
drop policy if exists "pm_members self update" on public.pm_members;

-- ---------------------------------------------------------------------------
-- 3. pm_invites — the accepted/expired columns ARE the enforcement
-- ---------------------------------------------------------------------------
drop policy if exists "pm_invites own revoke" on public.pm_invites;

-- ---------------------------------------------------------------------------
-- 4. pm_threads — every thread is made by a function that checks something
-- ---------------------------------------------------------------------------
drop policy if exists "pm_threads insert self" on public.pm_threads;

-- ---------------------------------------------------------------------------
-- 5. And the grants underneath, so a future policy cannot re-open them
-- ---------------------------------------------------------------------------
-- RLS with no policy for a command already denies it, so most of this is belt
-- and braces. It is worth the seven lines: the failure mode being guarded
-- against is somebody adding a policy for one column in a year's time and
-- getting all of them, which is exactly how three of the four above happened.
-- SELECT is left alone — the read policies above are the whole access model.
revoke insert, update, delete on public.pm_keys         from anon, authenticated;
revoke insert, update, delete on public.pm_members      from anon, authenticated;
revoke insert, update, delete on public.pm_threads      from anon, authenticated;
revoke insert, update, delete on public.pm_messages     from anon, authenticated;
revoke insert, update, delete on public.pm_message_keys from anon, authenticated;
revoke insert, update, delete on public.pm_sender_keys  from anon, authenticated;
revoke insert, update, delete on public.pm_invites      from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. A published key is checked for being a key
-- ---------------------------------------------------------------------------
-- An ECDH P-256 SPKI is 91 bytes, which is 122 base64url characters, and every
-- key in the table is exactly that. The range below is wider on purpose: this
-- is a shape check to keep junk out of a column nobody can repair from the
-- outside, not a second implementation of the curve.
--
-- Why it matters more than it looks: a garbled public key does not fail for
-- its owner. It fails for everyone who tries to WRITE to them — seal() throws
-- on import — and the owner's own screen looks perfectly healthy. There is no
-- way to notice, and no way for anyone else to fix it.
create or replace function public.pm_publish_key(
  p_public_key   text,
  p_fingerprint  text,
  p_display_name text default null,
  p_region       text default null
) returns public.pm_keys
  language plpgsql
  security definer
  set search_path = public
as $fn$
declare
  v_uid    text := public.app_uid();
  v_guest  boolean := public.app_is_guest();
  v_name   text;
  v_region text;
  v_agent  boolean := false;
  v_row    public.pm_keys;
begin
  if v_uid is null then
    raise exception 'Sign in before publishing a key';
  end if;
  if coalesce(p_public_key, '') = '' or coalesce(p_fingerprint, '') = '' then
    raise exception 'A public key and its fingerprint are both required';
  end if;
  if p_public_key !~ '^[A-Za-z0-9_-]{110,200}$' then
    raise exception 'That is not a P-256 public key';
  end if;
  -- The fingerprint is only ever a tamper signal — the client derives the real
  -- one from the key it received — but a column that holds anything at all is
  -- a column that will one day hold markup.
  if p_fingerprint !~ '^[0-9 ]{1,80}$' then
    raise exception 'Malformed safety number';
  end if;

  -- is_agent and is_guest are NOT arguments and never will be. They are the
  -- two facts this function exists to establish on the caller's behalf.
  if not v_guest then
    select ap.name, ap.region, true into v_name, v_region, v_agent
    from public.agent_profiles ap where ap.user_id = v_uid;
  end if;

  insert into public.pm_keys (user_id, public_key, fingerprint, display_name, region, is_agent, is_guest)
  values (
    v_uid, p_public_key, p_fingerprint,
    coalesce(nullif(trim(coalesce(p_display_name, '')), ''), v_name),
    coalesce(v_region, p_region),
    coalesce(v_agent, false),
    v_guest
  )
  on conflict (user_id) do update set
    public_key   = excluded.public_key,
    fingerprint  = excluded.fingerprint,
    display_name = coalesce(excluded.display_name, public.pm_keys.display_name),
    region       = coalesce(excluded.region, public.pm_keys.region),
    is_agent     = excluded.is_agent,
    is_guest     = excluded.is_guest,
    updated_at   = now()
  returning * into v_row;

  return v_row;
end $fn$;

-- ---------------------------------------------------------------------------
-- 7. Limits, in one place so they cannot drift apart
-- ---------------------------------------------------------------------------
-- 64 kB of base64 is about 48 kB of text — some tens of thousands of words. A
-- message is not a file, and there are no attachments in this feature yet;
-- when there are, they will be their own table with their own ceiling rather
-- than a bigger number here.
create or replace function public.pm_max_ciphertext()
  returns int language sql immutable as $fn$ select 65536 $fn$;

-- Per minute, per sender, across all threads. High enough that nobody typing
-- will ever see it and low enough that a loop stops being free.
create or replace function public.pm_max_msgs_per_min()
  returns int language sql immutable as $fn$ select 60 $fn$;

-- New conversations per hour. Guests keep their own, much tighter limit in
-- pm_start_direct; this is the one that did not exist at all.
create or replace function public.pm_max_threads_per_hour()
  returns int language sql immutable as $fn$ select 40 $fn$;

-- The rate limits read these ranges on every send. Without the indexes they
-- are sequential scans over the whole table, which turns a safety check into
-- the slowest thing in the request.
create index if not exists pm_messages_sender_recent_idx
  on public.pm_messages (sender_id, sent_at desc);
create index if not exists pm_threads_creator_recent_idx
  on public.pm_threads (created_by, created_at desc);

-- ---------------------------------------------------------------------------
-- 8. pm_send — as before, plus a ceiling and a rate
-- ---------------------------------------------------------------------------
create or replace function public.pm_send(
  p_thread     uuid,
  p_iv         text,
  p_ciphertext text,
  p_keys       jsonb
) returns uuid
  language plpgsql
  security definer
  set search_path = public
as $fn$
declare
  v_uid text := public.app_uid();
  v_msg uuid;
  v_n   int;
begin
  if v_uid is null then raise exception 'Sign in first'; end if;
  if not exists (select 1 from public.pm_members where thread_id = p_thread and user_id = v_uid) then
    raise exception 'You are not in that conversation';
  end if;
  if coalesce(p_iv, '') = '' or coalesce(p_ciphertext, '') = '' then
    raise exception 'Nothing to send';
  end if;
  if length(p_ciphertext) > public.pm_max_ciphertext() then
    raise exception 'That message is too long to send';
  end if;
  if p_keys is null or jsonb_array_length(p_keys) = 0 then
    raise exception 'A message needs at least one wrapped key';
  end if;

  select count(*) into v_n from public.pm_messages
  where sender_id = v_uid and sent_at > now() - interval '1 minute';
  if v_n >= public.pm_max_msgs_per_min() then
    raise exception 'Too many messages in one minute. Wait a moment.';
  end if;

  insert into public.pm_messages (thread_id, sender_id, iv, ciphertext)
  values (p_thread, v_uid, p_iv, p_ciphertext)
  returning id into v_msg;

  insert into public.pm_message_keys (message_id, user_id, epk, wrapped_key)
  select v_msg, k->>'user_id', k->>'epk', k->>'wrapped_key'
  from jsonb_array_elements(p_keys) k
  where exists (
    select 1 from public.pm_members m
    where m.thread_id = p_thread and m.user_id = k->>'user_id'
  )
  on conflict (message_id, user_id) do nothing;

  update public.pm_threads set last_at = now() where id = p_thread;
  return v_msg;
end $fn$;

-- ---------------------------------------------------------------------------
-- 9. Sender keys — the generation must MATCH, not merely not-be-older
-- ---------------------------------------------------------------------------
create or replace function public.pm_sender_key_put(
  p_thread     uuid,
  p_generation int,
  p_keys       jsonb
) returns int
  language plpgsql
  security definer
  set search_path = public
as $fn$
declare
  v_uid text := public.app_uid();
  v_gen int;
  v_n   int;
begin
  if v_uid is null then raise exception 'Sign in first'; end if;
  if not exists (select 1 from public.pm_members where thread_id = p_thread and user_id = v_uid) then
    raise exception 'You are not in that conversation';
  end if;
  if p_keys is null or jsonb_array_length(p_keys) = 0 then
    raise exception 'A sender key must be wrapped for at least one member';
  end if;

  select key_generation into v_gen from public.pm_threads where id = p_thread;
  if v_gen is null then raise exception 'No such conversation'; end if;
  -- EQUALITY, and the two directions are different mistakes worth naming
  -- separately. Behind means the client has not noticed a membership change.
  -- Ahead means a key that outlives every membership change that will ever be
  -- made — which is the one thing generations exist to prevent, and was
  -- accepted until this file because the check only looked for `<`.
  if p_generation < v_gen then
    raise exception 'That generation is stale — the room has changed since. Re-wrap at generation %', v_gen;
  end if;
  if p_generation > v_gen then
    raise exception 'The room has not reached generation % — wrap at generation %', p_generation, v_gen;
  end if;

  with ins as (
    insert into public.pm_sender_keys (thread_id, sender_id, generation, recipient_id, epk, wrapped_key)
    select p_thread, v_uid, p_generation, k->>'user_id', k->>'epk', k->>'wrapped_key'
    from jsonb_array_elements(p_keys) k
    where exists (
      select 1 from public.pm_members m
      where m.thread_id = p_thread and m.user_id = k->>'user_id')
    on conflict (thread_id, sender_id, generation, recipient_id) do nothing
    returning 1
  )
  select count(*)::int into v_n from ins;

  return v_n;
end $fn$;

create or replace function public.pm_send_sk(
  p_thread     uuid,
  p_generation int,
  p_seq        int,
  p_iv         text,
  p_ciphertext text
) returns uuid
  language plpgsql
  security definer
  set search_path = public
as $fn$
declare
  v_uid text := public.app_uid();
  v_gen int;
  v_msg uuid;
  v_n   int;
begin
  if v_uid is null then raise exception 'Sign in first'; end if;
  if not exists (select 1 from public.pm_members where thread_id = p_thread and user_id = v_uid) then
    raise exception 'You are not in that conversation';
  end if;
  if coalesce(p_iv, '') = '' or coalesce(p_ciphertext, '') = '' then
    raise exception 'Nothing to send';
  end if;
  if length(p_ciphertext) > public.pm_max_ciphertext() then
    raise exception 'That message is too long to send';
  end if;

  select key_generation into v_gen from public.pm_threads where id = p_thread;
  if v_gen is null then raise exception 'No such conversation'; end if;
  if p_generation < v_gen then
    raise exception 'The room has changed. Rotate your key to generation % before sending.', v_gen;
  end if;
  if p_generation > v_gen then
    raise exception 'The room has not reached generation % — rotate your key to generation %',
      p_generation, v_gen;
  end if;

  if not exists (
    select 1 from public.pm_sender_keys
    where thread_id = p_thread and sender_id = v_uid and generation = p_generation
  ) then
    raise exception 'Hand out your key for this generation before sending under it';
  end if;

  select count(*) into v_n from public.pm_messages
  where sender_id = v_uid and sent_at > now() - interval '1 minute';
  if v_n >= public.pm_max_msgs_per_min() then
    raise exception 'Too many messages in one minute. Wait a moment.';
  end if;

  insert into public.pm_messages (thread_id, sender_id, alg, iv, ciphertext, generation, seq)
  values (p_thread, v_uid, 'SK-A256GCM', p_iv, p_ciphertext, p_generation, p_seq)
  returning id into v_msg;

  update public.pm_threads set last_at = now() where id = p_thread;
  return v_msg;
end $fn$;

-- ---------------------------------------------------------------------------
-- 10. pm_start_direct — a limit for everyone, not only for guests
-- ---------------------------------------------------------------------------
-- pm_keys is readable by every signed-in caller, deliberately: it is the
-- directory, and hiding it would only stop people writing to each other. The
-- consequence is that "open a thread with every user in the country" is a
-- loop, and until now nothing counted it unless the caller was anonymous. A
-- real account is a higher bar than a guest session, so its limit is looser —
-- but a bar is not the same thing as no bar.
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

  -- The idempotent lookup FIRST, so re-opening an existing conversation never
  -- counts against a limit. Tapping somebody you already talk to is not the
  -- behaviour either limit is aimed at, and charging for it would lock people
  -- out of their own inbox.
  select t.id into v_id
  from public.pm_threads t
  where t.kind = 'direct'
    and exists (select 1 from public.pm_members m where m.thread_id = t.id and m.user_id = v_uid)
    and exists (select 1 from public.pm_members m where m.thread_id = t.id and m.user_id = p_other)
    and (select count(*) from public.pm_members m where m.thread_id = t.id) = 2
  limit 1;
  if v_id is not null then return v_id; end if;

  if v_guest then
    if not exists (select 1 from public.pm_keys where user_id = p_other and is_agent) then
      raise exception 'Guests can only message agents. Sign in to message anyone.';
    end if;
  end if;

  select count(*) into v_recent
  from public.pm_threads t
  where t.created_by = v_uid and t.created_at > now() - interval '1 hour';

  if v_guest and v_recent >= 5 then
    raise exception 'Too many new conversations in one hour. Try again later, or sign in.';
  end if;
  if v_recent >= public.pm_max_threads_per_hour() then
    raise exception 'Too many new conversations in one hour. Try again later.';
  end if;

  insert into public.pm_threads (kind, created_by) values ('direct', v_uid) returning id into v_id;
  insert into public.pm_members (thread_id, user_id, role) values
    (v_id, v_uid, 'owner'), (v_id, p_other, 'member');
  return v_id;
end $fn$;

-- ---------------------------------------------------------------------------
-- 11. pm_broadcast — the same ceiling, and members who can actually read it
-- ---------------------------------------------------------------------------
create or replace function public.pm_broadcast(
  p_title      text,
  p_region     text,
  p_iv         text,
  p_ciphertext text,
  p_keys       jsonb,
  p_thread     uuid default null
) returns uuid
  language plpgsql
  security definer
  set search_path = public
as $fn$
declare
  v_uid    text := public.app_uid();
  v_thread uuid;
  v_msg    uuid;
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  if p_keys is null or jsonb_array_length(p_keys) = 0 then
    raise exception 'Nobody in that scope has set up P-Message yet';
  end if;
  if coalesce(p_iv, '') = '' or coalesce(p_ciphertext, '') = '' then
    raise exception 'Nothing to send';
  end if;
  if length(p_ciphertext) > public.pm_max_ciphertext() then
    raise exception 'That announcement is too long to send';
  end if;

  insert into public.pm_threads (id, kind, title, region, created_by)
  values (coalesce(p_thread, gen_random_uuid()), 'broadcast',
          coalesce(nullif(trim(coalesce(p_title, '')), ''), 'Announcement'),
          nullif(p_region, ''), v_uid)
  returning id into v_thread;

  -- Only people who actually hold a key become members. The admin's browser
  -- chose this list, and an admin is trusted — but "trusted" is not the same
  -- as "unchecked", and a user id that is not in pm_keys is a row nobody can
  -- ever read.
  insert into public.pm_members (thread_id, user_id, role)
  select v_thread, k->>'user_id', 'member'
  from jsonb_array_elements(p_keys) k
  where exists (select 1 from public.pm_keys pk where pk.user_id = k->>'user_id')
  on conflict do nothing;
  insert into public.pm_members (thread_id, user_id, role)
  values (v_thread, v_uid, 'owner')
  on conflict (thread_id, user_id) do update set role = 'owner';

  insert into public.pm_messages (thread_id, sender_id, iv, ciphertext)
  values (v_thread, v_uid, p_iv, p_ciphertext)
  returning id into v_msg;

  insert into public.pm_message_keys (message_id, user_id, epk, wrapped_key)
  select v_msg, k->>'user_id', k->>'epk', k->>'wrapped_key'
  from jsonb_array_elements(p_keys) k
  where exists (
    select 1 from public.pm_members m
    where m.thread_id = v_thread and m.user_id = k->>'user_id')
  on conflict (message_id, user_id) do nothing;

  return v_thread;
end $fn$;

-- ---------------------------------------------------------------------------
-- 12. The one write an admin genuinely has, kept working
-- ---------------------------------------------------------------------------
-- p_message.sql gave admins a DELETE policy on pm_keys, for abuse and for a
-- lost device. Revoking the table's DELETE grant above would have quietly
-- taken that away — the policy would still read correctly and never be
-- reached, which is the worst kind of broken. It moves to a function instead,
-- like every other write in this feature.
--
-- Note what deleting a key does and does not do. It stops NEW messages being
-- sealed to that person, because there is nothing left to seal to. It does not
-- reach onto their device, and it does not delete a message: every past thread
-- stays exactly as readable to them as it was. Saying otherwise in an admin
-- screen would be a lie about a security action, which is the sort of lie that
-- gets acted on.
drop policy if exists "pm_keys admin all" on public.pm_keys;

create or replace function public.pm_admin_delete_key(p_user_id text)
  returns int
  language plpgsql
  security definer
  set search_path = public
as $fn$
declare v_n int;
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  if coalesce(p_user_id, '') = '' then raise exception 'Which key?'; end if;
  with del as (delete from public.pm_keys where user_id = p_user_id returning 1)
  select count(*)::int into v_n from del;
  return v_n;
end $fn$;

-- ---------------------------------------------------------------------------
-- 13. Grants
-- ---------------------------------------------------------------------------
grant execute on function public.pm_max_ciphertext()       to anon, authenticated;
grant execute on function public.pm_max_msgs_per_min()     to anon, authenticated;
grant execute on function public.pm_max_threads_per_hour() to anon, authenticated;
grant execute on function public.pm_admin_delete_key(text) to authenticated;

commit;

-- ============================================================================
-- After this file, the only ways to write anything in P-Message are the
-- SECURITY DEFINER functions, every one of which checks something before it
-- writes. The tables answer SELECT to the people the read policies name, and
-- answer nothing else to anybody.
-- ============================================================================
