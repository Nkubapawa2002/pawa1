-- ============================================================================
-- agent_billing — monetization: track which agents are paying
-- ============================================================================
-- The admin "All Agents" tracker (admin.html) de-duplicates every agent on the
-- platform (bus/cargo agents + house-listing agents + truck owners) into a
-- single identity string. Billing attaches to that same identity so a paying
-- status follows the agent regardless of how many listings they have.
--
--   agent_key — the stable identity computed by the tracker, one of:
--                 "uid:<owner_user_id>"  (house/truck agents — preferred)
--                 "ph:<last 9 digits>"   (bus agents / no account)
--                 "nm:<lowercased name>" (last-resort fallback)
--
-- Run this once in the Supabase SQL editor. Safe to re-run (idempotent).
-- ----------------------------------------------------------------------------
create table if not exists public.agent_billing (
  agent_key   text primary key,
  name        text,                       -- denormalised for readability/export
  phone       text,
  status      text not null default 'free'
                check (status in ('free','trial','paid','overdue','cancelled')),
  plan        text,                       -- free-text tier, e.g. 'basic','pro'
  amount_tzs  bigint not null default 0 check (amount_tzs >= 0),
  paid_until  date,                        -- subscription / access expiry
  note        text,
  updated_by  text,                        -- admin email who last changed it
  updated_at  timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

create index if not exists agent_billing_status_idx on public.agent_billing (status);
create index if not exists agent_billing_paid_until_idx on public.agent_billing (paid_until);

-- Keep updated_at fresh on every change (reuses the shared trigger fn).
drop trigger if exists set_agent_billing_updated_at on public.agent_billing;
create trigger set_agent_billing_updated_at
  before update on public.agent_billing
  for each row execute function public.touch_updated_at();

-- Admin-only: billing is sensitive, never world-readable.
alter table public.agent_billing enable row level security;
drop policy if exists "agent_billing admin read"  on public.agent_billing;
drop policy if exists "agent_billing admin write" on public.agent_billing;
create policy "agent_billing admin read" on public.agent_billing
  for select using (public.is_admin());
create policy "agent_billing admin write" on public.agent_billing
  for all using (public.is_admin()) with check (public.is_admin());
