-- ===========================================================================
--  account_delete.sql — a person can take themselves out of this app.
--
--  WHY THIS FILE IS LONG, AND WHY IT IS ALL EXPLICIT DELETES.
--
--  The obvious implementation is `delete from auth.users where id = me` and
--  let the database cascade. On THIS database that is close to the worst
--  possible thing to run, for three separate reasons, all verified against
--  production before this file was written:
--
--   1. houses.owner_user_id, services.owner_user_id, trucks.owner_user_id,
--      house_tenancies.owner_user_id and house_demand_pins.user_id are all
--      `text` with NO foreign key to auth.users. They hold the JWT subject as
--      a string, a shape inherited from the Clerk era (supabase/auth/
--      clerk_text_user_ids.sql). Nothing cascades. Deleting the auth row
--      leaves every listing LIVE ON THE PUBLIC BOARD, with the person's phone
--      number on it, owned by an id that can never sign in to take it down.
--      That is the opposite of what somebody asking to be deleted wants.
--
--   2. The whole pm_* set is the same shape. Orphaned silently.
--
--   3. tenant_invites.invited_by IS a uuid foreign key to auth.users, with no
--      ON DELETE clause, which means NO ACTION. It does not cascade; it
--      REFUSES. One such row exists today, so the delete would simply fail
--      with a constraint violation and no explanation.
--
--  So erasure is an ordered list of deletes, written out, in the order a
--  human would check them. The order matters in one place only and it is
--  noted there.
--
--  WHAT CANNOT BE ERASED, AND THE FEATURE MUST SAY SO OUT LOUD.
--  A message this person SENT is sealed, on the recipient's phone, under a
--  key this server has never held. There is no delete-for-everyone and there
--  cannot be. The best available is a tombstone: the row stays, the
--  ciphertext is emptied, and anybody who still has their own copy keeps it.
--  js/lib/pm-hidden.js already follows this rule and the dialog repeats it.
--  Promising more would be the one kind of lie a delete-my-account button
--  must never tell.
--
--  DEPENDS ON: p_message_reach_guests.sql (for the orphaned-room rule this
--  borrows) and the pm_* tables. Safe to re-apply.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The P-Message half, on its own, granted to nobody.
--
--    Two callers need exactly this: an account deleting itself, and an account
--    that wants to leave P-Message while keeping the account. Writing it twice
--    is how the two drift, and a drifted erasure is one that leaves something
--    behind. (pm_guest_forget keeps its own copy on purpose: it is the guest
--    contract, it is already applied, already tested, and already wired.)
-- ---------------------------------------------------------------------------
create or replace function public.pm_erase_identity(p_uid text, p_wipe_messages boolean)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $fn$
declare
  v_threads int    := 0;
  v_msgs    int    := 0;
  v_rooms   int    := 0;
  v_left    uuid[] := '{}';
begin
  if coalesce(p_uid, '') = '' then
    raise exception 'No account named';
  end if;

  if coalesce(p_wipe_messages, false) then
    with gone as (
      update public.pm_messages m
         set deleted_at = now(),
             deleted_by = p_uid,
             ciphertext = '',
             iv         = ''
       where m.sender_id = p_uid
         and m.deleted_at is null
      returning m.id
    )
    select count(*) into v_msgs from gone;

    delete from public.pm_message_keys k
     using public.pm_messages m
     where k.message_id = m.id
       and m.sender_id = p_uid
       and m.deleted_at is not null;
  end if;

  -- Leave every conversation, keeping the thread ids in a local array. A temp
  -- table would be the obvious shape and is the wrong one: this function pins
  -- `search_path = public`, and pg_temp is exactly the schema that pinning
  -- exists to keep out of relation lookups.
  with departed as (
    delete from public.pm_members where user_id = p_uid returning thread_id
  )
  select coalesce(array_agg(distinct thread_id), '{}') into v_left from departed;
  v_threads := coalesce(array_length(v_left, 1), 0);

  -- A room this was the last member of is ciphertext no living key can open.
  -- Same rule pm_group_leave and pm_guest_forget already apply.
  with dead as (
    delete from public.pm_threads t
     where t.id = any (v_left)
       and t.kind in ('group', 'broadcast')
       and not exists (select 1 from public.pm_members m where m.thread_id = t.id)
    returning 1
  )
  select count(*) into v_rooms from dead;

  -- Everything else that names this person inside P-Message. pm_blocks goes in
  -- BOTH directions: a block somebody else placed on a person who no longer
  -- exists is a row about nobody, and leaving it would mean a recycled id
  -- could inherit a stranger's block.
  delete from public.pm_list_members where user_id = p_uid;
  delete from public.pm_list_members  m using public.pm_lists l
    where m.list_id = l.id and l.owner_id = p_uid;
  delete from public.pm_lists        where owner_id = p_uid;
  delete from public.pm_blocks       where blocker_id = p_uid or blocked_id = p_uid;
  delete from public.pm_sender_keys  where sender_id = p_uid or recipient_id = p_uid;
  delete from public.pm_invites      where agent_id = p_uid or accepted_by = p_uid;
  delete from public.pm_presence     where user_id = p_uid;
  delete from public.pm_keys         where user_id = p_uid;

  return jsonb_build_object(
    'threads', v_threads, 'messages', v_msgs, 'rooms_closed', v_rooms);
end $fn$;

revoke all on function public.pm_erase_identity(text, boolean) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Leaving P-Message without leaving the app.
--
--    A guest has had this since p_message_guest_end.sql. An account has never
--    had it: the only thing that could remove an account's pm_keys row was
--    pm_admin_delete_key(), which is admins-only and which nothing calls. So
--    the person with the most invested in the feature had the least control
--    over it.
-- ---------------------------------------------------------------------------
create or replace function public.pm_key_forget(p_wipe_messages boolean default false)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $fn$
declare v_uid text := public.app_uid();
begin
  if coalesce(v_uid, '') = '' then
    raise exception 'Sign in first';
  end if;
  -- A guest has pm_guest_forget, which also ends the session. Sending them
  -- here would leave them signed in with no key and no way to be reached,
  -- which is a state nothing else in the app produces.
  if public.app_is_guest() then
    raise exception 'A guest session ends with pm_guest_forget';
  end if;
  return public.pm_erase_identity(v_uid, p_wipe_messages);
end $fn$;

revoke all on function public.pm_key_forget(boolean) from public, anon;
grant execute on function public.pm_key_forget(boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. The whole account.
--
--    Takes NO user id, and never will. A function that erases "whoever you
--    name" is one bad grant away from being the worst endpoint in the schema;
--    this one can only ever reach the caller.
--
--    Returns a count per area so the dialog can report what actually went
--    rather than asserting success.
-- ---------------------------------------------------------------------------
create or replace function public.account_erase(p_wipe_messages boolean default true)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $fn$
declare
  v_uid     text := public.app_uid();
  -- The nullif() is not decoration. current_setting(..., true) returns the
  -- EMPTY STRING rather than null in some contexts, and ''::jsonb raises
  -- "invalid input syntax for type json" -- which would make this function
  -- fail for reasons that have nothing to do with deleting anything.
  -- app_is_guest() guards it the same way and for the same reason.
  v_email   text := nullif(
                      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email',
                      '');
  v_pm      jsonb;
  v_houses  int := 0;
  v_svcs    int := 0;
  v_trucks  int := 0;
  v_jobs    int := 0;
  v_demand  int := 0;
  v_tenancy int := 0;
begin
  if coalesce(v_uid, '') = '' then
    raise exception 'Sign in first';
  end if;

  -- A guest has pm_guest_forget and owns nothing else: the catalogue refuses
  -- a guest insert at the RLS level (p_message_guests.sql), so there is
  -- nothing here for one to erase.
  if public.app_is_guest() then
    raise exception 'A guest session ends with pm_guest_forget';
  end if;

  -- THE LAST ADMIN CANNOT DELETE THEMSELVES. Not paternalism: admins is the
  -- table is_admin() reads, and emptying it locks every console on the
  -- platform with no way back in through the app.
  if v_email is not null
     and exists (select 1 from public.admins a where lower(a.email) = lower(v_email))
     and (select count(*) from public.admins) <= 1 then
    raise exception 'You are the only admin. Add another before deleting this account.';
  end if;

  -- ---- the public board first --------------------------------------------
  -- Before anything else, because these are the rows other people can SEE.
  -- If this function fails half way, the failure should have taken the
  -- listings down rather than the private half.
  with d as (delete from public.houses   where owner_user_id = v_uid returning 1)
    select count(*) into v_houses from d;
  with d as (delete from public.services where owner_user_id = v_uid returning 1)
    select count(*) into v_svcs from d;
  with d as (delete from public.trucks   where owner_user_id = v_uid returning 1)
    select count(*) into v_trucks from d;
  with d as (delete from public.day_job_owners where owner_user_id = v_uid returning 1)
    select count(*) into v_jobs from d;
  with d as (delete from public.house_demand_pins where user_id = v_uid returning 1)
    select count(*) into v_demand from d;
  with d as (delete from public.house_tenancies where owner_user_id = v_uid returning 1)
    select count(*) into v_tenancy from d;

  -- ---- who they were -----------------------------------------------------
  delete from public.agent_profiles where user_id = v_uid;
  delete from public.agents         where user_id = v_uid;
  delete from public.account_kinds  where user_id = v_uid;
  delete from public.owner_posts    where user_id = v_uid;
  delete from public.agent_messages where to_user_id = v_uid;
  delete from public.live_locations where user_id = v_uid;
  delete from public.meet_rooms     where created_by = v_uid;
  delete from public.loc_share_misses where user_id = v_uid;

  -- ---- P-Message ---------------------------------------------------------
  v_pm := public.pm_erase_identity(v_uid, p_wipe_messages);

  -- ---- the two rows that would REFUSE the auth delete --------------------
  -- tenant_invites.invited_by is a uuid FK to auth.users with no ON DELETE,
  -- so it does not cascade, it blocks. Null it here or the Edge Function in
  -- supabase/functions/delete-account fails with a constraint violation and
  -- nothing to show the person. region_video_defaults.updated_by is ON DELETE
  -- SET NULL and needs nothing; region_videos cascades and is left to do so.
  begin
    update public.tenant_invites set invited_by = null
     where invited_by::text = v_uid;
  exception when others then
    -- A uuid cast of a non-uuid subject raises; that simply means this
    -- account cannot be referenced there, which is the state we wanted.
    null;
  end;

  if v_email is not null then
    delete from public.admins where lower(email) = lower(v_email);
  end if;

  return jsonb_build_object(
    'houses',    v_houses,
    'services',  v_svcs,
    'trucks',    v_trucks,
    'jobs',      v_jobs,
    'requests',  v_demand,
    'tenancies', v_tenancy,
    'messages',  coalesce(v_pm ->> 'messages', '0')::int,
    'threads',   coalesce(v_pm ->> 'threads', '0')::int,
    'rooms_closed', coalesce(v_pm ->> 'rooms_closed', '0')::int);
end $fn$;

revoke all on function public.account_erase(boolean) from public, anon;
grant execute on function public.account_erase(boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. What an account is about to lose, BEFORE it presses anything.
--
--    A confirm dialog that says "this cannot be undone" and does not say what
--    "this" is, is asking for consent to something unnamed.
-- ---------------------------------------------------------------------------
create or replace function public.account_footprint()
  returns jsonb
  language sql
  stable
  security definer
  set search_path = public
as $fn$
  select jsonb_build_object(
    'houses',    (select count(*) from public.houses   where owner_user_id = public.app_uid()),
    'services',  (select count(*) from public.services where owner_user_id = public.app_uid()),
    'trucks',    (select count(*) from public.trucks   where owner_user_id = public.app_uid()),
    'jobs',      (select count(*) from public.day_job_owners where owner_user_id = public.app_uid()),
    'requests',  (select count(*) from public.house_demand_pins where user_id = public.app_uid()),
    'tenancies', (select count(*) from public.house_tenancies where owner_user_id = public.app_uid()),
    'threads',   (select count(*) from public.pm_members where user_id = public.app_uid()),
    'messages',  (select count(*) from public.pm_messages
                   where sender_id = public.app_uid() and deleted_at is null),
    'has_key',   (select exists (select 1 from public.pm_keys where user_id = public.app_uid()))
  )
  where coalesce(public.app_uid(), '') <> '';
$fn$;

revoke all on function public.account_footprint() from public, anon;
grant execute on function public.account_footprint() to authenticated;
