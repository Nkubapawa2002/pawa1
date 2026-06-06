-- Additional costs / bills shown to clients on each house listing.
-- Array of { label, amount, billing } where billing ∈ month|metered|included|oneoff.
-- Idempotent — safe to re-run.
alter table public.houses
  add column if not exists extra_costs jsonb not null default '[]'::jsonb;
