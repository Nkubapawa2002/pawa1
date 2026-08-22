-- ============================================================================
--  day_jobs_owner.sql — a day job posted by somebody, instead of by nobody.
-- ============================================================================
--  THE HOLE THIS FILLS
--
--  public.day_jobs records company_name and company_phone. It does not record
--  an account. So a day job is the only thing on this site that is owned by a
--  string rather than by a person, and the consequences of that spread much
--  further than the jobs board:
--
--   · P-Message cannot offer "jobs" as a category. Its whole model is "what
--     does this person actually have listed" — see pm_owner_listings — and a
--     table with no owner column contributes nothing to it. Three separate
--     files say so in comments (p_message_finder.sql, p_message_groups.sql,
--     js/lib/pm-match.js), all of them ending "it cannot be added without
--     first giving day_jobs an owner". This is that.
--
--   · A poster who loses their manage_token loses their own workers. The
--     token is minted once, handed back once, and kept in localStorage; clear
--     the browser and the list of who claimed your slots is gone for good.
--     With an owner there is a second, durable way to prove it is your job.
--
--  WHAT OWNERSHIP DELIBERATELY DOES *NOT* GRANT
--
--  No update policy, no delete policy. claimed_count and status are the quota,
--  and the quota is enforced by claim_day_job() holding a row lock. Handing
--  the owner a direct UPDATE would let a poster set claimed_count back to zero
--  and oversubscribe their own job — the exact race the lock exists to stop.
--  Ownership here is attribution and a read path, nothing more. Editing and
--  closing still go through admin, as they did before.
--
--  BACKFILL: none, and none is possible. Jobs posted before this column
--  existed were posted by a phone number. There is no honest way to guess
--  which account that was, and guessing would attach a stranger's job to
--  somebody's P-Message profile. Legacy rows keep owner_user_id null, count
--  toward nobody, and are exactly as messageable as they were yesterday.
--
--  SUPERSEDED IN PART by day_jobs_owner_table.sql, which moved owner_user_id
--  off the world-readable day_jobs row and into public.day_job_owners. Apply
--  this file FIRST on a fresh database — updated_at and the touch trigger are
--  still only created here — then that one. It refuses to run a second time
--  once the correction is in place; see the guard below for why.
--
--  Idempotent until superseded. Depends on day_jobs.sql.
--
--    usage:  node scripts/db/apply_sql.mjs supabase/features/job/day_jobs_owner.sql
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 0. Stop if the correction has already been applied
-- ---------------------------------------------------------------------------
-- This file put owner_user_id ON public.day_jobs, which is world-readable and
-- read with `select *` everywhere, so the column published "account X posted
-- this job" beside a public phone number. day_jobs_owner_table.sql moved
-- ownership into public.day_job_owners for that reason.
--
-- Everything else here still stands and is still needed: updated_at, the touch
-- trigger, and the reasoning below about guests, backfill and what ownership
-- does not grant. So the file is kept and still runs FIRST on a fresh database.
-- What it must not do is run again AFTERWARDS: `add column if not exists` would
-- put the leaking column back, and the two `create or replace` bodies below
-- would quietly revert post_day_job() and day_job_workers() to reading it.
--
-- Re-running is how that would happen — this file is listed as a dependency in
-- three other headers, and "apply the dependencies first" is exactly the habit
-- that would undo the fix. An error is the honest answer.
do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'day_job_owners'
  ) then
    raise exception
      'superseded: public.day_job_owners already exists — day_jobs_owner_table.sql moved ownership off the public row. Re-applying this file would restore the leaking day_jobs.owner_user_id column. Apply supabase/features/job/day_jobs_owner_table.sql instead.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. The column
-- ---------------------------------------------------------------------------
-- text, not uuid, and no foreign key to auth.users — user ids in this schema
-- are Clerk subject strings (see supabase/auth/clerk_text_user_ids.sql), and
-- houses / services / trucks all carry owner_user_id as text for that reason.
-- A day job matching the three tables it will be counted alongside is the
-- whole point of the exercise.
alter table public.day_jobs add column if not exists owner_user_id text;

-- Nullable forever. A job posted by a signed-out phone is a real job; it just
-- has nobody to message about it, and saying that with a null is more honest
-- than inventing a placeholder account.
create index if not exists day_jobs_owner_idx
  on public.day_jobs (owner_user_id) where owner_user_id is not null;

-- ---------------------------------------------------------------------------
-- 2. updated_at, because the ranking decays on it
-- ---------------------------------------------------------------------------
-- pm_owner_listings carries updated_at from every table it unions, and
-- js/lib/pm-match.js halves an agent's freshness term every 180 days on the
-- most recent one. day_jobs had created_at only. Defaulting to now() and
-- backfilling from created_at means an old job reads as old rather than as
-- touched-this-second, which is the difference between the decay working and
-- the decay lying.
alter table public.day_jobs add column if not exists updated_at timestamptz;
update public.day_jobs set updated_at = created_at where updated_at is null;
alter table public.day_jobs alter column updated_at set default now();
alter table public.day_jobs alter column updated_at set not null;

drop trigger if exists day_jobs_touch on public.day_jobs;
create trigger day_jobs_touch
  before update on public.day_jobs
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 3. Posting attributes the job to whoever posted it
-- ---------------------------------------------------------------------------
-- Same signature, same return shape, same manage_token: nothing that calls
-- this has to change. The only difference is that a signed-in poster is now
-- recorded as the owner.
--
-- Guests are excluded on purpose. An anonymous session is a browser tab with
-- a nickname on it; attributing a job to one would put a disposable identity
-- into a directory that people use to decide who to trust, and P-Message
-- already refuses to list guests for exactly that reason. A guest still gets
-- their manage_token and still sees their workers — they simply do not become
-- a person you can look up.
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

  v_owner := case when public.app_is_guest() then null
                  else nullif(coalesce(public.app_uid(), ''), '') end;

  insert into public.day_jobs (
    title, description, requirements, company_name, company_phone,
    region, area, lat, lng, workers_needed, pay_tzs, pay_note, work_date,
    time_note, owner_user_id
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
    nullif(trim(coalesce(p->>'time_note', '')), ''),
    v_owner
  ) returning * into v_row;

  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into public.day_job_owner_tokens (job_id, manage_token) values (v_row.id, v_token);

  return json_build_object('ok', true, 'token', v_token, 'job', row_to_json(v_row));
end $$;

grant execute on function public.post_day_job(json) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Two ways to prove a job is yours, not one
-- ---------------------------------------------------------------------------
-- The manage_token stays exactly as strong as it was and is still the only
-- route for a signed-out poster. What is added is an OR, not a replacement:
-- the recorded owner, checked against app_uid() inside the function, can read
-- their own workers without producing a secret they may no longer have.
--
-- The company phone is still not accepted here, for the reason the original
-- header gives: it is printed on the public board, so accepting it would let
-- anyone on the internet harvest every worker's phone number. An account is
-- not printed anywhere.
drop function if exists public.day_job_workers(bigint, text);
create function public.day_job_workers(p_job_id bigint, p_manage_token text default null)
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
        select 1 from public.day_jobs j
        where j.id = p_job_id
          and j.owner_user_id is not null
          and j.owner_user_id = public.app_uid()
      )
    )
  order by c.created_at;
$$;

grant execute on function public.day_job_workers(bigint, text) to anon, authenticated;

commit;
