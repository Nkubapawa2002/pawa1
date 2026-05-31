-- Section 55 of schema_master.sql — generic admin approval queue.
-- Idempotent; safe to re-run on both fresh and existing databases.

-- Fresh installs: create the table.
create table if not exists public.pending_changes (
  id              bigserial primary key,
  entity_type     text        not null,
  action          text        not null check (action in ('insert','update','delete')),
  entity_id       text,
  payload         jsonb       not null default '{}'::jsonb,
  requested_by    text,
  requested_at    timestamptz not null default now(),
  status          text        not null default 'pending'
                    check (status in ('pending','approved','rejected')),
  reviewed_by     text,
  reviewed_at     timestamptz,
  review_note     text,
  reject_reason   text
);

-- Existing installs: backfill any columns that were missing from older versions.
alter table public.pending_changes add column if not exists review_note text;
alter table public.pending_changes add column if not exists reject_reason text;

create index if not exists pending_changes_status_idx
  on public.pending_changes (status, requested_at desc);

alter table public.pending_changes enable row level security;

drop policy if exists "pending_changes insertable" on public.pending_changes;
create policy "pending_changes insertable"
  on public.pending_changes for insert with check (true);

drop policy if exists "pending_changes selectable" on public.pending_changes;
create policy "pending_changes selectable"
  on public.pending_changes for select using (true);

drop policy if exists "pending_changes updatable" on public.pending_changes;
create policy "pending_changes updatable"
  on public.pending_changes for update using (true);
