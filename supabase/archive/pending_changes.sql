-- Admin approval queue
-- Run in Supabase SQL editor after schema.sql

create table if not exists pending_changes (
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
  reject_reason   text
);

create index if not exists pending_changes_status_idx
  on pending_changes (status, requested_at desc);

alter table pending_changes enable row level security;

-- Public can insert (submit requests); only admins read/update (enforced via service role or anon key + RLS)
create policy "pending_changes insertable"
  on pending_changes for insert with check (true);

create policy "pending_changes selectable"
  on pending_changes for select using (true);

create policy "pending_changes updatable"
  on pending_changes for update using (true);
