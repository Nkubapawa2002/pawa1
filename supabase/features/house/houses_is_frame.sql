-- ============================================================================
-- houses_is_frame.sql — explicit "this is a Frame (business space)" flag
-- ============================================================================
-- A Frame is a "room for business" — a shop, office, godown, stall, kiosk, etc.
-- Agents now tick a checkbox on the listing form to mark a listing as a Frame,
-- and only Frames appear on the Frame opportunity map (frame.html). A normal
-- residential room (e.g. a master room) is NOT a Frame.
--
-- This adds the boolean column the form writes. Listings without it still work:
-- frame.js falls back to inferring a Frame from the type/title when the flag is
-- absent, so existing shops/offices keep showing even before they're re-saved.
--
-- Idempotent. Safe to re-run. Paste into the Supabase SQL editor and Run.
-- ============================================================================
begin;

alter table public.houses
  add column if not exists is_frame boolean not null default false;

-- Partial index — we only ever query for the Frames (the true rows).
create index if not exists houses_is_frame_idx
  on public.houses (is_frame) where is_frame;

commit;

-- ============================================================================
-- Done. Verify:  select count(*) from public.houses where is_frame;
-- ============================================================================
