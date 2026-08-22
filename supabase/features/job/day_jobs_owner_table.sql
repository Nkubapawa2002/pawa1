-- ============================================================================
--  day_jobs_owner_table.sql — the owner moves off the public row.
-- ============================================================================
--  A CORRECTION to day_jobs_owner.sql, which put owner_user_id ON public
--  day_jobs. That table is `for select using (true)` and every client reads it
--  with `select *`, so the column went straight out to anon — and it went out
--  sitting beside company_phone.
--
--  That pairing is the problem. P-Message's directory returns where somebody
--  works and never their phone, deliberately and in every function that
--  touches it. Publishing "account 658d…f3 posted this job" next to a public
--  phone number hands out the join those functions exist to withhold, to
--  anybody, without signing in.
--
--  The fix is the pattern day_jobs.sql already established one table over:
--  day_job_owner_tokens lives in its own table with NO anon/authenticated
--  access precisely "so it can never leak through the public day_jobs read".
--  Ownership belongs in the same place, for the same reason.
--
--  WHAT MOVES
--  day_jobs.owner_user_id -> day_job_owners.owner_user_id. Nothing else about
--  the model changes: no backfill (there is nothing to backfill — the column
--  never held a value in production), no owner UPDATE/DELETE policy, guests
--  still excluded at post time. day_jobs.updated_at STAYS on the row; a
--  timestamp says nothing about who anyone is, and the ranking decays on it.
--
--  WHAT THIS BUYS BACK
--  `select *` on day_jobs keeps working everywhere — data.js, admin.js,
--  jobs.js, chat.js, ai-tools.js, frame.js — with no column lists to keep in
--  sync and no chance of one of them being missed. Column-level REVOKE would
--  have broken all six.
--
--  AND ADDS
--  day_job_posters(), the one thing jobs.html needs to draw a Message button:
--  given the job ids on screen, which of them were posted by somebody who can
--  actually receive an encrypted message. See its own note on what it will
--  and will not say.
--
--  Idempotent. Safe to re-run. Depends on day_jobs.sql, day_jobs_owner.sql,
--  p_message.sql. Re-apply p_message_jobs.sql after this — it is the file that
--  owns pm_owner_listings, and the view is recreated here only so the column
--  underneath it can be dropped.
--
--    usage:  node scripts/db/apply_sql.mjs supabase/features/job/day_jobs_owner_table.sql
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. The table nobody can read
-- ---------------------------------------------------------------------------
-- RLS on and NOT ONE POLICY. That is not an oversight to be tidied up later:
-- with RLS enabled and no policy, anon and authenticated match no rows at all,
-- and the only things that can see it are the SECURITY DEFINER functions
-- below, each of which checks something before it answers.
create table if not exists public.day_job_owners (
  job_id        bigint primary key references public.day_jobs(id) on delete cascade,
  owner_user_id text not null,
  created_at    timestamptz not null default now()
);

create index if not exists day_job_owners_user_idx
  on public.day_job_owners (owner_user_id);

alter table public.day_job_owners enable row level security;

-- ---------------------------------------------------------------------------
-- 2. Move whatever the old column holds, then take it away
-- ---------------------------------------------------------------------------
-- The view has to go first: a plain `alter table ... drop column` refuses
-- while a view selects from it, and CASCADE here would drop the view without
-- saying so. Dropping it deliberately is the honest version of the same thing.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'day_jobs'
      and column_name = 'owner_user_id'
  ) then
    insert into public.day_job_owners (job_id, owner_user_id)
      select id, owner_user_id from public.day_jobs where owner_user_id is not null
      on conflict (job_id) do nothing;
  end if;
end $$;

drop view if exists public.pm_owner_listings;
drop index if exists public.day_jobs_owner_idx;
alter table public.day_jobs drop column if exists owner_user_id;

-- Rebuilt here so this file leaves a working database on its own. The jobs arm
-- now joins the side table. p_message_jobs.sql remains the file that OWNS this
-- view; re-applying it after this one is a no-op and is the safer habit.
create view public.pm_owner_listings as
  select owner_user_id as user_id, 'houses'::text as cat,
         coalesce(verified, false) as verified, updated_at
    from public.houses   where owner_user_id is not null
  union all
  select owner_user_id, 'services',
         coalesce(verified, false), updated_at
    from public.services where owner_user_id is not null
  union all
  select owner_user_id, 'trucks',
         coalesce(verified, false), updated_at
    from public.trucks   where owner_user_id is not null
  union all
  select o.owner_user_id, 'jobs', false, d.updated_at
    from public.day_jobs d
    join public.day_job_owners o on o.job_id = d.id;

revoke all on public.pm_owner_listings from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Posting writes the owner to the side table
-- ---------------------------------------------------------------------------
-- Same signature, same return shape, same manage_token. The returned `job` no
-- longer carries an owner field, which is the point — the row handed back to
-- the poster is the row everyone else can see.
create or replace function public.post_day_job(p json)
returns json
language plpgsql security definer set search_path = public as $$
declare
  v_row   public.day_jobs%rowtype;
  v_token text;
  v_owner text;
begin
  if coalesce(trim(p->>'title'), '') = ''
     or coalesce(trim(p->>'company_name'), '') = ''
     or coalesce(trim(p->>'company_phone'), '') = '' then
    return json_build_object('ok', false, 'reason', 'missing_fields');
  end if;

  -- Guests are excluded on purpose: an anonymous session is a browser tab with
  -- a nickname on it, and P-Message refuses to list guests for the same reason.
  v_owner := case when public.app_is_guest() then null
                  else nullif(coalesce(public.app_uid(), ''), '') end;

  insert into public.day_jobs (
    title, description, requirements, company_name, company_phone,
    region, area, lat, lng, workers_needed, pay_tzs, pay_note, work_date,
    time_note
  ) values (
    trim(p->>'title'),
    nullif(trim(coalesce(p->>'description', '')), ''),
    nullif(trim(coalesce(p->>'requirements', '')), ''),
    trim(p->>'company_name'),
    trim(p->>'company_phone'),
    nullif(p->>'region', ''),
    nullif(p->>'area', ''),
    nullif(p->>'lat', '')::double precision,
    nullif(p->>'lng', '')::double precision,
    greatest(1, least(500, coalesce(nullif(p->>'workers_needed', '')::int, 1))),
    nullif(p->>'pay_tzs', '')::numeric,
    nullif(trim(coalesce(p->>'pay_note', '')), ''),
    nullif(p->>'work_date', '')::date,
    nullif(trim(coalesce(p->>'time_note', '')), '')
  ) returning * into v_row;

  if v_owner is not null then
    insert into public.day_job_owners (job_id, owner_user_id)
      values (v_row.id, v_owner) on conflict (job_id) do nothing;
  end if;

  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into public.day_job_owner_tokens (job_id, manage_token) values (v_row.id, v_token);

  return json_build_object('ok', true, 'token', v_token, 'job', row_to_json(v_row));
end $$;

grant execute on function public.post_day_job(json) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Two ways to prove a job is yours, reading the new table
-- ---------------------------------------------------------------------------
create or replace function public.day_job_workers(p_job_id bigint, p_manage_token text default null)
returns table (worker_name text, worker_phone text, worker_code text, created_at timestamptz)
language sql security definer set search_path = public as $$
  select c.worker_name, c.worker_phone, c.worker_code, c.created_at
  from public.day_job_claims c
  where c.job_id = p_job_id
    and (
      exists (
        select 1 from public.day_job_owner_tokens t
        where t.job_id = p_job_id
          and coalesce(p_manage_token, '') <> ''
          and t.manage_token = p_manage_token
      )
      or exists (
        select 1 from public.day_job_owners o
        where o.job_id = p_job_id
          and o.owner_user_id = public.app_uid()
          and coalesce(public.app_uid(), '') <> ''
      )
    )
  order by c.created_at;
$$;

grant execute on function public.day_job_workers(bigint, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Which of these jobs can I actually write to?
-- ---------------------------------------------------------------------------
-- The whole API behind the Message button on jobs.html, and it is written to
-- give away as little as it can while still answering the question.
--
--  · Signed-in callers only. Guests included — a guest can already message an
--    agent — but the public anon key on its own gets nothing, which is what
--    the old public column got wrong.
--  · Only posters who ALREADY HAVE A PUBLIC KEY. This is the line that makes
--    the disclosure a non-event: everyone it can name is somebody the caller
--    could already have found in pm_agent_finder, so it reveals no account
--    that was not reachable through the directory a moment ago. It also
--    happens to be the honest UI rule — an owner with no key cannot receive an
--    encrypted message, and a button that opens a dead end is worse than no
--    button.
--  · Never your own job. You do not need to be offered a chat with yourself.
--  · Never a phone number, from either side. The job's own phone is on the
--    board already; the POSTER'S account contact is not ours to hand out, and
--    pm_directory has never done it.
--
-- Takes the ids on screen rather than answering "list every job with an owner",
-- so it stays a lookup for a page that is already showing those jobs.
create or replace function public.day_job_posters(p_job_ids bigint[])
  returns table (
    job_id       bigint,
    user_id      text,
    display_name text,
    region       text,
    area         text
  )
  language sql
  stable
  security definer
  set search_path = public
as $fn$
  select
    o.job_id,
    o.owner_user_id,
    coalesce(k.display_name, ap.name),
    coalesce(k.region, ap.region),
    ap.area_of_operations
  from public.day_job_owners o
  join public.pm_keys k on k.user_id = o.owner_user_id
  left join public.agent_profiles ap on ap.user_id = o.owner_user_id
  where o.job_id = any (coalesce(p_job_ids, '{}'::bigint[]))
    and k.public_key is not null
    and not coalesce(k.is_guest, false)
    and coalesce(public.app_uid(), '') <> ''
    and o.owner_user_id <> coalesce(public.app_uid(), '')
  limit 500;
$fn$;

grant execute on function public.day_job_posters(bigint[]) to anon, authenticated;

commit;

-- ============================================================================
-- What is still true after this, and worth stating rather than discovering:
--
--  · A signed-in caller who clicks Message does learn that this account posted
--    this job, and the job carries a public phone. That association cannot be
--    avoided by anyone who actually uses the feature — the client needs the
--    peer's public key to encrypt to them. What IS avoided is handing it to
--    the whole internet, and handing it out for accounts that were never in
--    the directory to begin with.
--
--  · Legacy day jobs have no owner and never will. They were posted by a phone
--    number; guessing the account behind one would attach a stranger's job to
--    somebody's profile. They show a Call button and no Message button.
-- ============================================================================
