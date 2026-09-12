-- ===========================================================================
--  p_message_reach_opened.sql
--
--  TWO CHANGES, both about who a person can actually reach, and both provoked
--  by the same report: "the announce and rooms is not working".
--
--  They were not broken. Every function was applied and every grant correct.
--  The AUDIENCE was empty, and on the production data it was empty by
--  construction: 16 people had ever opened P-Message, 15 of them guests, and
--  ZERO messages had ever been sent. pm_my_people, pm_recipients and
--  pm_group_candidates all returned nothing, for everybody, so both dialogs
--  opened onto a list with no rows and a send button that could never enable.
--
--  ------------------------------------------------------------------------
--  1. pm_deals_with gains ONE arm: a direct thread THEY opened.
--  ------------------------------------------------------------------------
--
--  The rule was "a direct thread we have BOTH written in, or an accepted
--  invite". The reasoning for refusing a one-sided thread is sound and is kept:
--  pm_start_direct is unilateral (40/hour, the other person is never notified),
--  so a thread NOBODY answered would cost an attacker one extra call per
--  victim, and room membership grants nothing for the same reason.
--
--  But that reasoning is about a thread *I* opened. A thread *they* opened is
--  their own decision to walk into the shop, and it is the single commonest
--  way a real customer appears: they press Message on a listing, which calls
--  pm_start_direct, and then they wait for the agent to say something. Under
--  the old rule that agent could not put that customer in a room or an
--  announcement until the customer had also written -- which is backwards,
--  because the customer is waiting on the agent.
--
--  THE ASYMMETRY IS THE WHOLE SAFETY ARGUMENT, so state it plainly:
--
--    pm_deals_with(p_other) asks "may I reach p_other".
--    The new arm is satisfied only when p_other CREATED the thread.
--
--  An attacker calling pm_start_direct at 500 victims creates 500 threads with
--  created_by = the attacker. For the attacker to reach a victim, the arm
--  needs a thread the VICTIM created. It is not satisfied, and cannot be
--  manufactured. It is satisfied in the other direction, which is correct: a
--  person who opened a conversation with you may be answered by you.
--
--  If anybody ever "simplifies" this to "a direct thread either of us
--  created", that is the hole. tests/p_message_audience_test.mjs sections 4
--  and 12 are what fail.
--
--  ------------------------------------------------------------------------
--  2. pm_agent_finder stops listing accounts that cannot sign in.
--  ------------------------------------------------------------------------
--
--  A guest browsing the directory saw two agents. One was real. The other was
--  `user_3FAMy8GfVOeFV72J7pbiu1MTBjf` -- a Clerk-era id, from before this app
--  moved to Supabase auth. It has an agent_profiles row and a truck listing,
--  no pm_keys row, no auth.users row, and last listed anything in June. It can
--  never sign in, so it can never publish a key, so it can never be written
--  to. Verified: there are ZERO `user_%` ids in auth.users.
--
--  The fence is auth.users membership rather than the `user_%` prefix,
--  because the prefix is the symptom and "can this person ever sign in" is the
--  question. The rest of the row was already honest -- actionsHtml() draws no
--  Message chip without a public key -- but a directory of people you can
--  message is the wrong place to draw somebody nobody can message.
--
--  pm_agent_card is deliberately NOT fenced. It answers "show me this
--  person's shop", the listings are real and the number on them works, and it
--  is reached by link rather than by browsing. Two different questions.
--
--  ------------------------------------------------------------------------
--  Everything NOT changed here, so a reader does not have to diff for it:
--  the guest SENDER check, the block being tested ahead of the admin arm, the
--  non-admin ceilings (60 / 200 / 3 / 3), pm_may_room_with's shopfront arm,
--  and the rule that room membership grants no reach at all.
-- ===========================================================================

create or replace function public.pm_deals_with(p_other text)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public
as $fn$
  select case
    when coalesce(public.app_uid(), '') = '' then false
    when p_other is null or p_other = public.app_uid() then false
    else
      -- Both of us have written in the same direct thread.
      exists (
        select 1
          from public.pm_threads t
          join public.pm_members me    on me.thread_id = t.id and me.user_id = public.app_uid()
          join public.pm_members other on other.thread_id = t.id and other.user_id = p_other
         where t.kind = 'direct'
           and exists (select 1 from public.pm_messages x
                        where x.thread_id = t.id and x.sender_id = public.app_uid())
           and exists (select 1 from public.pm_messages x
                        where x.thread_id = t.id and x.sender_id = p_other)
      )
      -- Or THEY opened a direct thread with me. Not one I opened: see the
      -- header. created_by = p_other is the entire fence on this arm and it
      -- is not interchangeable with "either of us".
      or exists (
        select 1
          from public.pm_threads t
          join public.pm_members me    on me.thread_id = t.id and me.user_id = public.app_uid()
          join public.pm_members other on other.thread_id = t.id and other.user_id = p_other
         where t.kind = 'direct'
           and t.created_by = p_other
      )
      -- Or an invite passed between us and was accepted.
      or exists (
        select 1 from public.pm_invites i
         where i.accepted_by is not null
           and (   (i.agent_id = public.app_uid() and i.accepted_by = p_other)
                or (i.agent_id = p_other          and i.accepted_by = public.app_uid()))
      )
  end;
$fn$;

revoke all on function public.pm_deals_with(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
--  pm_agent_finder, unchanged apart from the auth.users fence in its final
--  WHERE. Lifted mechanically from p_message_call.sql rather than retyped.
-- ---------------------------------------------------------------------------

create or replace function public.pm_agent_finder(
  p_region   text default null,
  p_query    text default null,
  p_category text default null,
  p_limit    int  default 300
) returns table (
  user_id        text,
  display_name   text,
  region         text,
  area           text,
  area_kind      text,
  district       text,
  ward           text,
  lat            double precision,
  lng            double precision,
  is_agent       boolean,
  reachable      boolean,
  public_key     text,
  fingerprint    text,
  n_houses       int,
  n_services     int,
  n_trucks       int,
  n_jobs         int,
  n_verified     int,
  last_listed_at timestamptz,
  last_seen_at   timestamptz,
  kinds          text[],
  phone          text
)
  language sql
  stable
  security definer
  set search_path = public
as $fn$
  with people as (
    select
      ap.user_id,
      coalesce(k.display_name, ap.name)   as display_name,
      coalesce(k.region, ap.region)       as region,
      ap.area_of_operations               as area,
      ap.area_kind, ap.district, ap.ward,
      ap.lat, ap.lng,
      true                                as is_agent,
      (k.public_key is not null)          as reachable,
      k.public_key, k.fingerprint
    from public.agent_profiles ap
    left join public.pm_keys k on k.user_id = ap.user_id
    union
    select
      k.user_id, k.display_name, k.region,
      null::text, null::text, null::text, null::text,
      null::double precision, null::double precision,
      k.is_agent, true, k.public_key, k.fingerprint
    from public.pm_keys k
    where not exists (select 1 from public.agent_profiles ap2 where ap2.user_id = k.user_id)
      and not coalesce(k.is_guest, false)
  ),
  counted as (
    select
      p.*,
      (select count(*)::int from public.pm_owner_listings o
        where o.user_id = p.user_id and o.cat = 'houses')          as n_houses,
      (select count(*)::int from public.pm_owner_listings o
        where o.user_id = p.user_id and o.cat = 'services')        as n_services,
      (select count(*)::int from public.pm_owner_listings o
        where o.user_id = p.user_id and o.cat = 'trucks')          as n_trucks,
      (select count(*)::int from public.pm_owner_listings o
        where o.user_id = p.user_id and o.cat = 'jobs')            as n_jobs,
      (select count(*)::int from public.pm_owner_listings o
        where o.user_id = p.user_id and o.verified)                as n_verified,
      (select max(o.updated_at) from public.pm_owner_listings o
        where o.user_id = p.user_id)                               as last_listed_at,
      (select date_trunc('minute', pr.last_seen_at) from public.pm_presence pr
        where pr.user_id = p.user_id)                              as last_seen_at,
      (select array_agg(t.kind order by t.n desc, t.kind)
         from (
           select o.kind, count(*) as n
             from public.pm_owner_listings o
            where o.user_id = p.user_id
              and o.kind is not null and btrim(o.kind) <> ''
              and (p_category is null or p_category = '' or o.cat = p_category)
            group by o.kind
            order by count(*) desc, o.kind
            limit 4
         ) t)                                                      as kinds,
      -- The number off the listing they touched last. The jobs arm is fenced
      -- to people who already hold a P-Message key: see the header. Nulls sort
      -- last, so a listing with no number never beats one that has one.
      (select o.phone from public.pm_owner_listings o
        where o.user_id = p.user_id
          and o.phone is not null
          and (o.cat <> 'jobs' or p.reachable)
        order by o.updated_at desc nulls last
        limit 1)                                                   as phone
    from people p
  )
  select
    user_id, display_name, region, area, area_kind, district, ward, lat, lng,
    is_agent, reachable, public_key, fingerprint,
    n_houses, n_services, n_trucks, n_jobs, n_verified, last_listed_at,
    last_seen_at, kinds, phone
  from counted
  where (p_region is null or p_region = '' or region = p_region)
    and (
      p_query is null or p_query = '' or
      display_name ilike '%' || p_query || '%' or
      area         ilike '%' || p_query || '%' or
      district     ilike '%' || p_query || '%' or
      ward         ilike '%' || p_query || '%' or
      exists (
        select 1 from public.pm_owner_listings o
        where o.user_id = counted.user_id
          and (p_category is null or p_category = '' or o.cat = p_category)
          and (o.kind ilike '%' || p_query || '%' or o.title ilike '%' || p_query || '%')
      )
    )
    and (
      p_category is null or p_category = '' or
      case p_category
        when 'houses'   then n_houses   > 0
        when 'services' then n_services > 0
        when 'trucks'   then n_trucks   > 0
        when 'jobs'     then n_jobs     > 0
        else false
      end
    )
    -- The account must still be able to sign in. An agent_profiles row whose
    -- id is not in auth.users is a Clerk-era leftover: it can never hold a
    -- key, so it can never be written to, and a directory of people you can
    -- message is the wrong place to draw it. Its listings and the number on
    -- them stay exactly where they were, on the catalogue pages.
    and exists (select 1 from auth.users u where u.id::text = counted.user_id)
    and coalesce(public.app_uid(), '') <> ''
    and user_id <> coalesce(public.app_uid(), '')
  order by reachable desc, is_agent desc, display_name nulls last
  limit greatest(1, least(coalesce(p_limit, 300), 500));
$fn$;
grant execute on function public.pm_agent_finder(text, text, text, int) to anon, authenticated;
