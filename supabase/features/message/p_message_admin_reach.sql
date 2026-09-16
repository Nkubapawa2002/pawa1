-- ============================================================================
--  p_message_admin_reach.sql — the admin arm moves above the guest arm.
-- ============================================================================
--  WHAT WAS MEASURED, BEFORE ANYTHING WAS CHANGED
--
--  p_message_reach_guests.sql opened the two predicates to an invited customer
--  who had accepted a link and talked back. That was right, and it was not
--  enough. Counted in production on 2026-09-15:
--
--      auth.users      28   ->  27 anonymous, 1 real account
--      pm_keys         16   ->  15 is_guest, 1 not
--      pm_threads       0       (0 direct, 0 group, 0 broadcast)
--      pm_invites       1       (0 accepted)
--
--  The one non-guest key belongs to the one row in public.admins. So: the
--  admin is the only non-guest account that exists, and everybody they might
--  gather is a guest.
--
--  Now read pm_may_room_with as it stands. Self is excluded. A block is
--  refused. Then the guest arm fires, BEFORE the admin arm, and hands the
--  answer to pm_deals_with, which wants either a direct thread both people
--  have written in, or an accepted invite. There are zero threads and zero
--  accepted invites.
--
--  The admin's audience is therefore the empty set, and has been since the day
--  the feature shipped. Not "hard to use": every room the admin tries to open
--  dies on 'None of those people have set up P-Message yet', and every
--  announcement on the matching sentence. That is the bug being fixed here,
--  and it is one CASE arm in the wrong place.
--
--  WHAT CHANGES, AND WHAT DELIBERATELY DOES NOT
--
--    moves   `when public.is_admin() then true` now sits ABOVE the guest arm
--            in both predicates, so an admin may gather or announce to a guest.
--
--    stays   The BLOCK is still checked first, above the admin arm, exactly as
--            p_message_audience.sql argued: an admin who could step over a
--            personal block would make the block a promise with an asterisk on
--            it. That reasoning is untouched and the ordering proves it.
--
--    stays   A GUEST STILL SENDS NOTHING. app_is_guest() is refused in both
--            predicates before any of this, and again inside pm_group_create
--            and pm_broadcast. Opening the admin's reach TO guests is not the
--            same as letting guests reach anybody, and the asymmetry is the
--            whole point: an anonymous tab can be spoken to by the platform
--            and still not be able to advertise to the country.
--
--    stays   An ordinary account's rules are not touched. A non-admin still
--            needs pm_deals_with for a guest, and still gets the shopfront arm
--            for a real account. Their caps (pm_group_max_open, 3 rooms a day)
--            are unchanged.
--
--  WHY A GUEST IS NOT AN UNTOUCHABLE HERE
--  The original clause read "a guest cannot publish a listing at all, so for a
--  guest 'we deal with each other' is the only door". True, and it describes a
--  guest's own reach. It says nothing about the platform's reach to them. The
--  people in that table named themselves ("incharge", "Kakay", "Pp"), came
--  back, and are the entire user base. A rule that keeps the operator of the
--  service from putting its own users in a room is not protecting them from a
--  stranger; there is no stranger in this system yet.
--
--  NO SIGNATURE CHANGES. Both are plain `create or replace` of the exact
--  signature p_message_reach_guests.sql left behind, so every caller
--  (pm_group_create, pm_group_add, pm_broadcast, pm_audience_check,
--  pm_my_people, the picker) picks the new body up with no redeploy and there
--  is never a window with no function. No defaulted parameter is added, so no
--  second overload appears for PostgREST to refuse to choose between.
--
--  Idempotent. Safe to re-run. Depends on p_message_audience.sql and
--  p_message_reach_guests.sql, and must run AFTER both.
--
--    usage:  node scripts/db/apply_sql.mjs supabase/features/message/p_message_admin_reach.sql
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. An announcement may reach them
-- ---------------------------------------------------------------------------
create or replace function public.pm_may_cast_to(p_other text)
  returns boolean
  language sql
  stable security definer
  set search_path = public
as $fn$
  select case
    when coalesce(public.app_uid(), '') = '' then false
    when p_other is null or p_other = public.app_uid() then false
    -- A guest SENDING is still refused. A guest session is a browser tab: it
    -- may answer an agent (pm_start_direct has its own arm for that) and it
    -- may reach nobody new.
    when public.app_is_guest() then false
    -- Before the admin arm, deliberately. A block an admin could step over is
    -- a promise with an asterisk on it.
    when public.pm_blocked_between(public.app_uid(), p_other) then false
    -- MOVED UP, above the guest arm. The platform's own account may speak to
    -- the people using it, guest sessions included, because 27 of the 28
    -- accounts in this database are guest sessions and the previous ordering
    -- left the admin with nobody at all. Everything protecting a guest from
    -- everyone ELSE is in the arm below, untouched.
    when public.is_admin() then true
    -- A guest RECEIVING is refused as a stranger, which is what this clause
    -- was always for. An invited customer who accepted the link and talked to
    -- you is not a stranger.
    when coalesce((select k.is_guest from public.pm_keys k where k.user_id = p_other), false)
      then public.pm_deals_with(p_other)
    else public.pm_deals_with(p_other)
  end;
$fn$;

-- ---------------------------------------------------------------------------
-- 2. A room may hold them
-- ---------------------------------------------------------------------------
create or replace function public.pm_may_room_with(p_other text)
  returns boolean
  language sql
  stable security definer
  set search_path = public
as $fn$
  select case
    when coalesce(public.app_uid(), '') = '' then false
    when p_other is null or p_other = public.app_uid() then false
    when public.app_is_guest() then false
    when public.pm_blocked_between(public.app_uid(), p_other) then false
    -- MOVED UP, for the reason given above. A room is the weaker of the two
    -- in every direction that matters: it is two-way, the member can see who
    -- else is in it, and they can leave. Being put in one by the operator of
    -- the service is not the imposition that being on a stranger's
    -- advertising list is.
    when public.is_admin() then true
    -- The shopfront arm below deliberately does NOT extend to guests: a guest
    -- cannot publish a listing at all, so for a guest reached by an ORDINARY
    -- account "we deal with each other" is still the only door.
    when coalesce((select k.is_guest from public.pm_keys k where k.user_id = p_other), false)
      then public.pm_deals_with(p_other)
    when public.pm_deals_with(p_other) then true
    else coalesce((select k.is_agent from public.pm_keys k where k.user_id = p_other), false)
         or exists (select 1 from public.pm_owner_listings o where o.user_id = p_other)
  end;
$fn$;

grant execute on function public.pm_may_cast_to(text)   to anon, authenticated;
grant execute on function public.pm_may_room_with(text) to anon, authenticated;

commit;

-- ---------------------------------------------------------------------------
--  Afterwards, as the admin, this should stop being zero:
--
--    select count(*) from public.pm_keys k
--     where k.user_id <> public.app_uid()
--       and public.pm_may_room_with(k.user_id);
--
--  and tests/p_message_group_test.mjs must still pass unchanged: it asserts
--  that an ORDINARY account cannot gather somebody who has published nothing,
--  which is the arm this file did not touch.
-- ---------------------------------------------------------------------------
