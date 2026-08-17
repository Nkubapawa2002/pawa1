-- ============================================================================
-- houses.available — is the listing still on the public market?
--
-- Default TRUE (every listing is live). When an agent records a COMPLETED deal
-- (an active tenant in house_tenancies) the app flips it FALSE so the house
-- drops out of the public directories; when that tenancy ends it flips back to
-- TRUE (re-listed). Idempotent.
-- ============================================================================

alter table public.houses
  add column if not exists available boolean not null default true;

create index if not exists houses_available_idx on public.houses (available);
