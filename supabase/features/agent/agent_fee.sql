-- Agent commission ("dalali" fee) the tenant pays the agent for a rental deal,
-- shown separately from the rent. Optional per listing: when 0/null the UI
-- (house detail + agent dashboard) defaults to one month's rent. Agents can set
-- a custom amount (e.g. half a month, or a flat fee) in the new-listing form.
--
-- Run this once in the Supabase SQL editor. Safe to re-run (idempotent).
-- Without it, listings still save (the app drops the field gracefully) but a
-- custom fee won't persist and every listing falls back to one month's rent.

alter table public.houses
  add column if not exists agent_fee_tzs bigint not null default 0
  check (agent_fee_tzs >= 0);
