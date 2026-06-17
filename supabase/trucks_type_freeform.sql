-- ============================================================================
-- Trucks: free-form truck type
--
-- Mirrors houses_type_freeform.sql. The listing form used to hard-limit
-- `trucks.truck_type` to ('pickup','canter','3ton','7ton','10ton_plus','other').
-- Providers can now pick "Other (any kind)" and type whatever they run
-- (tipper, flatbed, refrigerated, fuso, …). So we drop the CHECK constraint and
-- allow any short text. Curated values are still suggested in the UI; the
-- directory filter matches them by equality, unknown kinds show under "any".
--
-- Safe to run more than once. Run this in the Supabase SQL editor.
-- ============================================================================

alter table public.trucks
  drop constraint if exists trucks_truck_type_check;

-- Keep a sane guard: non-empty, reasonably short. (Optional — remove if undesired.)
alter table public.trucks
  drop constraint if exists trucks_truck_type_nonblank;
alter table public.trucks
  add  constraint trucks_truck_type_nonblank
  check (char_length(btrim(truck_type)) between 1 and 40);
