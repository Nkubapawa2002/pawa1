-- ============================================================================
-- house_tenancies: add the house owner (landlord) phone.
--
-- When an agent marks a deal "Completed", they record the customer's contact
-- AND the house owner's number (so the agent knows who to reach when the rental
-- ends / the tenant moves). Idempotent — safe to re-run.
-- ============================================================================

alter table public.house_tenancies
  add column if not exists landlord_phone text;
