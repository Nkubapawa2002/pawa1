-- ============================================================================
-- Houses: free-form property type
--
-- The listing form used to hard-limit `houses.type` to
-- ('apartment','house','plot','office'). Providers now also list a "Shop /
-- business space" (a place for selling products) and an "Other (any kind)"
-- option that stores whatever kind they type. So we drop the CHECK constraint
-- and let `type` hold any short text. Curated values are still suggested in the
-- UI; the directory filter matches them by equality, and unknown kinds simply
-- show under "Type: any".
--
-- Safe to run more than once. Run this in the Supabase SQL editor.
-- ============================================================================

alter table public.houses
  drop constraint if exists houses_type_check;

-- Keep a sane guard: non-empty, reasonably short. (Optional — remove if undesired.)
alter table public.houses
  drop constraint if exists houses_type_nonblank;
alter table public.houses
  add  constraint houses_type_nonblank
  check (char_length(btrim(type)) between 1 and 40);
