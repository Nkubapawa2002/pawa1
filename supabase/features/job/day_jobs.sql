-- ============================================================================
-- Day jobs (vibarua) board — companies post short-term jobs, workers claim
-- slots ("vote") until the quota is full.
--
--   day_jobs        the job post: what, where (map pin), when, pay, quota
--   day_job_claims  one row per worker who claimed a slot (phone-deduped)
--   claim_day_job() atomic claim: locks the job row, enforces the quota,
--                   bumps claimed_count, flips status to 'full' at the cap
--
-- Privacy: workers' phone numbers are NOT publicly readable. The public only
-- sees day_jobs (including claimed_count); claims go in through the RPC.
-- The poster proves ownership with a per-job secret (manage_token) handed back
-- only to them at post time — NOT with the company phone (which is public on
-- the board, so phone "verification" would let anyone harvest worker contacts).
-- Run this whole file in the Supabase SQL editor.
-- ============================================================================

create table if not exists public.day_jobs (
  id              bigserial primary key,
  title           text not null,
  description     text,                          -- what to do
  requirements    text,                          -- who can apply
  company_name    text not null,
  company_phone   text not null,
  region          text,
  area            text,
  lat             double precision,
  lng             double precision,
  workers_needed  int  not null default 1 check (workers_needed between 1 and 500),
  claimed_count   int  not null default 0,
  pay_tzs         numeric,                       -- pay per worker
  pay_note        text,                          -- e.g. "per day, paid same evening"
  work_date       date,                          -- the day the work happens
  time_note       text,                          -- e.g. "07:00 – 16:00"
  status          text not null default 'open'
    check (status in ('open','full','closed','expired')),
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null default (now() + interval '7 days')
);

create index if not exists day_jobs_status_idx  on public.day_jobs (status);
create index if not exists day_jobs_created_idx on public.day_jobs (created_at desc);

create table if not exists public.day_job_claims (
  id           bigserial primary key,
  job_id       bigint not null references public.day_jobs(id) on delete cascade,
  worker_name  text not null,
  worker_phone text not null,
  worker_code  text,                -- on-site worker ID, e.g. "W12-03" (job 12, worker #3)
  device_id    text,
  created_at   timestamptz not null default now(),
  unique (job_id, worker_phone)
);

alter table public.day_job_claims add column if not exists worker_code text;
create unique index if not exists day_job_claims_code_idx on public.day_job_claims (worker_code);

-- Per-job ownership secret. Lives in its own table with NO anon/authenticated
-- access, so it can never leak through the public day_jobs read. Only the
-- security-definer RPCs below touch it. The poster keeps their copy on-device.
create table if not exists public.day_job_owner_tokens (
  job_id       bigint primary key references public.day_jobs(id) on delete cascade,
  manage_token text not null,
  created_at   timestamptz not null default now()
);

-- Backfill a token for any job posted before this column existed (legacy posts
-- become admin-only for worker contacts until reposted — by design, since we
-- can't retroactively hand the old poster a secret they never received).
insert into public.day_job_owner_tokens (job_id, manage_token)
  select j.id, replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
  from public.day_jobs j
  left join public.day_job_owner_tokens t on t.job_id = j.id
  where t.job_id is null;

-- Backfill codes for claims made before the column existed.
update public.day_job_claims c
   set worker_code = 'W' || c.job_id || '-' || lpad(r.rn::text, 2, '0')
  from (select id, row_number() over (partition by job_id order by created_at) rn
          from public.day_job_claims) r
 where r.id = c.id and c.worker_code is null;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.day_jobs             enable row level security;
alter table public.day_job_claims       enable row level security;
alter table public.day_job_owner_tokens enable row level security;

-- The board is public-read (company name/phone/pay/pin are meant to be seen —
-- the phone powers the Call button). It is NOT public-insert: posting goes
-- through post_day_job() so every job is minted with an owner token. Counts and
-- status change only through the RPCs. No anon update/delete.
drop policy if exists "day_jobs public read"   on public.day_jobs;
drop policy if exists "day_jobs public insert" on public.day_jobs;   -- removed: was a free-for-all insert
create policy "day_jobs public read" on public.day_jobs for select using (true);

-- Owner tokens: no policies at all → unreachable by anon/authenticated.
-- Only the security-definer functions (which bypass RLS) can read/write them.

-- Claims: NO public select (worker phones stay private), NO public insert
-- (only the security-definer RPC writes here, so the quota can't be bypassed).
-- Admins (admins table, via is_admin()) can read claims and manage jobs.
drop policy if exists "day_job_claims admin read" on public.day_job_claims;
create policy "day_job_claims admin read" on public.day_job_claims
  for select using (public.is_admin());
drop policy if exists "day_jobs admin update" on public.day_jobs;
create policy "day_jobs admin update" on public.day_jobs
  for update using (public.is_admin()) with check (public.is_admin());
drop policy if exists "day_jobs admin delete" on public.day_jobs;
create policy "day_jobs admin delete" on public.day_jobs
  for delete using (public.is_admin());

-- ---------------------------------------------------------------------------
-- Atomic claim — the "vote" button.
-- Locks the job row so two simultaneous taps can't oversubscribe the quota.
-- Each accepted worker receives a unique on-site worker ID ("worker number"),
-- e.g. W12-03 = job 12, worker #3 — the company checks this at the work zone.
-- Returns: { ok, reason?, claimed, needed, code? }
-- ---------------------------------------------------------------------------
create or replace function public.claim_day_job(
  p_job_id bigint, p_name text, p_phone text, p_device text default null
) returns json
language plpgsql security definer set search_path = public as $$
declare
  v_job   public.day_jobs%rowtype;
  v_count int;
  v_code  text;
begin
  if coalesce(trim(p_name), '') = '' or coalesce(trim(p_phone), '') = '' then
    return json_build_object('ok', false, 'reason', 'missing_contact');
  end if;

  select * into v_job from public.day_jobs where id = p_job_id for update;
  if not found or v_job.status not in ('open') or v_job.expires_at < now() then
    return json_build_object('ok', false, 'reason', 'closed',
      'claimed', coalesce(v_job.claimed_count, 0), 'needed', coalesce(v_job.workers_needed, 0));
  end if;
  if v_job.claimed_count >= v_job.workers_needed then
    update public.day_jobs set status = 'full' where id = p_job_id;
    return json_build_object('ok', false, 'reason', 'full',
      'claimed', v_job.claimed_count, 'needed', v_job.workers_needed);
  end if;

  begin
    insert into public.day_job_claims (job_id, worker_name, worker_phone, device_id)
    values (p_job_id, trim(p_name), trim(p_phone), p_device);
  exception when unique_violation then
    return json_build_object('ok', false, 'reason', 'already',
      'claimed', v_job.claimed_count, 'needed', v_job.workers_needed);
  end;

  -- The job row is locked, so this count (= this worker's number) is race-safe.
  select count(*) into v_count from public.day_job_claims where job_id = p_job_id;
  v_code := 'W' || p_job_id || '-' || lpad(v_count::text, 2, '0');
  update public.day_job_claims
     set worker_code = v_code
   where job_id = p_job_id and worker_phone = trim(p_phone);

  update public.day_jobs
     set claimed_count = v_count,
         status = case when v_count >= workers_needed then 'full' else status end
   where id = p_job_id;

  return json_build_object('ok', true,
    'claimed', v_count, 'needed', v_job.workers_needed,
    'full', v_count >= v_job.workers_needed,
    'code', v_code);
end $$;

grant execute on function public.claim_day_job(bigint, text, text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Post a job — the only way to create a day_jobs row (public insert is off).
-- Mints a per-job ownership secret and returns it to the poster exactly once.
-- The client stores the token on-device; it is the proof of ownership for
-- day_job_workers() below. Returns: { ok, job, token } or { ok:false, reason }.
-- ---------------------------------------------------------------------------
create or replace function public.post_day_job(p json)
returns json
language plpgsql security definer set search_path = public as $$
declare
  v_row   public.day_jobs%rowtype;
  v_token text;
begin
  if coalesce(trim(p->>'title'), '') = ''
     or coalesce(trim(p->>'company_name'), '') = ''
     or coalesce(trim(p->>'company_phone'), '') = '' then
    return json_build_object('ok', false, 'reason', 'missing_fields');
  end if;

  insert into public.day_jobs (
    title, description, requirements, company_name, company_phone,
    region, area, lat, lng, workers_needed, pay_tzs, pay_note, work_date, time_note
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

  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into public.day_job_owner_tokens (job_id, manage_token) values (v_row.id, v_token);

  return json_build_object('ok', true, 'token', v_token, 'job', row_to_json(v_row));
end $$;

grant execute on function public.post_day_job(json) to anon, authenticated;

-- The poster (or admin) fetches the claimed workers' contacts + worker IDs by
-- presenting the per-job manage_token they received at post time. The phone is
-- NOT accepted here — it is public on the board, so it would authorize anyone.
drop function if exists public.day_job_workers(bigint, text);
create function public.day_job_workers(p_job_id bigint, p_manage_token text)
returns table (worker_name text, worker_phone text, worker_code text, created_at timestamptz)
language sql security definer set search_path = public as $$
  select c.worker_name, c.worker_phone, c.worker_code, c.created_at
  from public.day_job_claims c
  where c.job_id = p_job_id
    and exists (
      select 1 from public.day_job_owner_tokens t
      where t.job_id = p_job_id
        and t.manage_token = p_manage_token
        and coalesce(p_manage_token, '') <> ''
    )
  order by c.created_at;
$$;

grant execute on function public.day_job_workers(bigint, text) to anon, authenticated;

-- Cron helper (n8n / pg_cron): close out stale posts.
create or replace function public.expire_day_jobs()
returns void language sql as $$
  update public.day_jobs set status = 'expired'
  where status in ('open','full') and expires_at < now();
$$;

-- Realtime: the board updates live as slots fill.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'day_jobs'
  ) then
    alter publication supabase_realtime add table public.day_jobs;
  end if;
end $$;
