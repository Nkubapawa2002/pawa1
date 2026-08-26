-- ============================================================================
-- houses.pin — where the pin came from, and whether it is still standing on it.
--
-- THE FACT THIS COLUMN EXISTS TO CARRY
-- A listing has had lat/lng since the first day, and two listings with the same
-- two numbers have never been the same claim. One of them was pinned by an
-- agent dragging a marker onto a roof that looked about right from a satellite
-- photo. The other was pinned by the person who lives there, standing at the
-- gate, tapping once, in an end-to-end encrypted conversation with the agent.
-- A seeker who is about to spend a Saturday and a daladala fare on a viewing is
-- entitled to know which of those two they are looking at, and until now the
-- row said nothing at all.
--
-- THE SHAPE
--   {
--     "v": 1,
--     "via": "p-message" | "code" | "request" | "gps" | "hand",
--     "exact": true,                       -- still on the coordinates as sent
--     "acc": 25,                           -- metres, as the sender reported
--     "at": "2026-08-25T10:14:00.000Z",    -- when they sent it
--     "from_name": "Amina",
--     "from_user": "8c1f…",
--     "from_guest": false,
--     "origin": { "lat": -6.7924, "lng": 39.2083 },
--     "off_m": 0
--   }
--
-- `origin` is the coordinates AS SENT, kept even when the agent has since
-- moved the marker off them. Two things depend on it: re-opening the listing
-- to fix a price restores the seal instead of quietly converting somebody
-- else's pin into the agent's own, and `off_m` stays a checkable number rather
-- than a claim.
--
-- `exact` is the whole point. It is false the moment the marker sits more than
-- a house's width from `origin`, and js/pages/house.js says nothing at all in
-- that case rather than saying something weaker — a listing that has been
-- corrected by its agent is a normal listing, not a suspect one.
--
-- WHAT IS PUBLISHED HERE, AND THE COST OF IT
-- `houses` is world-readable ("houses readable" using (true)). from_name and
-- from_user therefore publish an association between a private person and a
-- property, to anyone who reads the table — including people the sender never
-- meant to tell. That is a deliberate product decision taken with the trade-off
-- on the table: the listing names its source so the pin can be trusted and, if
-- it is wrong, traced. It is the ONE place in this codebase where something a
-- person shared privately leaves the device that received it, and the listing
-- form says so on screen, next to the name, at the moment it becomes true —
-- see ah_seal_public in js/core/i18n.js.
--
-- Two things are deliberately NOT here even so: the thread the pin arrived in,
-- and the words around it. Which room somebody speaks in is not "who pinned
-- this", and the conversation stays on the device, in js/lib/place-book.js.
--
-- WHY JSONB AND NOT SIX COLUMNS
-- The same reason as houses.details: the ways a location can arrive is not a
-- finished list. loc_share, a P-Message thread, a meet room and the agent's own
-- GPS are four doors today; a fifth should not need a migration before a
-- listing can say something true about itself. The client owns the shape
-- (js/pages/agent-houses.js, pinRecord()/loadPinRecord()) and tolerates rows
-- written by older builds.
--
-- Idempotent: safe to re-run.
-- ============================================================================

alter table public.houses
  add column if not exists pin jsonb not null default '{}'::jsonb;

-- An array or a string would pass jsonb's own validation and then break every
-- reader that expects `.exact`. Say object, once, at the boundary.
do $$
begin
  if not exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    where t.relname = 'houses' and c.conname = 'houses_pin_object'
  ) then
    alter table public.houses
      add constraint houses_pin_object
      check (jsonb_typeof(pin) = 'object');
  end if;
end $$;

-- A provenance record is a dozen short scalars. Anything approaching this size
-- is somebody using the column as a scratchpad, and every listing query would
-- carry it over the wire.
do $$
begin
  if not exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    where t.relname = 'houses' and c.conname = 'houses_pin_size'
  ) then
    alter table public.houses
      add constraint houses_pin_size
      check (pg_column_size(pin) <= 2048);
  end if;
end $$;

-- "Show me only listings pinned by somebody who was standing there" is the one
-- question this column will be asked at scale, and it is a filter over a
-- minority of rows — which is exactly what a partial index is for. A GIN index
-- over the whole column would cost more and answer no question anybody has.
create index if not exists houses_pin_exact_idx
  on public.houses ((pin ->> 'exact'))
  where pin ->> 'exact' = 'true';

comment on column public.houses.pin is
  'Pin provenance: { v, via, exact, acc, at, from_name, from_user, from_guest, origin, off_m }. '
  'Shape owned by js/pages/agent-houses.js — see supabase/features/house/houses_pin.sql.';
