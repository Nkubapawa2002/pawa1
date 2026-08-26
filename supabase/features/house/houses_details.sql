-- ============================================================================
-- houses.details — the spec sheet an agent writes themselves.
--
-- WHY A JSONB COLUMN AND NOT TWENTY MORE COLUMNS
-- The facts a Tanzanian letting turns on are not a finite list. Deposit terms,
-- the hour the gate closes, which days the tap runs, whether the road turns to
-- sand in the rain, whether there is a title deed and who signs the lease —
-- every one of those is a column somebody has to think of in advance, and the
-- next agent will always have a twenty-first fact that matters more than any
-- of them. A schema that has to be edited before a listing can say something
-- true is a schema that quietly teaches agents to put everything in the
-- description, where nothing can be searched, compared or drawn.
--
-- So the shape is open and the CLIENT owns it (js/lib/house-spec.js):
--
--   {
--     "v": 1,
--     "rooms":  [ { kind, label, price, period, count, vacant,
--                   ensuite, size, furnished, note } ],
--     "groups": [ { key, title, items: [ { label, value, note } ] } ]
--   }
--
-- rooms[] is the half that carries money — a plot with three singles at 60,000
-- and a master at 150,000 is ONE listing with four rooms, and the cheapest of
-- them is what the card means by "from TZS 60,000".
--
-- groups[] is every other fact, as titled label→value lines. Four groups ship
-- with suggestions; the fifth is one the agent names. Nothing is required and
-- no category is fixed.
--
-- WHAT THE DATABASE ENFORCES, and what it deliberately does not
-- It enforces that the value is an OBJECT and that it is not enormous. It does
-- NOT enforce the inner shape: a CHECK constraint over jsonb structure would
-- have to be dropped and rewritten on every change to the client catalogue,
-- which is the exact coupling this column exists to avoid. house-spec.js
-- normalise()s on the way in and on the way out, so a row written by an older
-- build still reads correctly on a newer one.
--
-- The size ceiling is real, though. Without it one pasted essay per line and
-- forty lines makes a row that every listing query has to carry over the wire.
-- 24 rooms, 12 groups and 40 lines per group is far more than any real listing
-- uses; 60 kB is roughly ten times what a fully-filled sheet weighs.
--
-- Idempotent: safe to re-run.
-- ============================================================================

alter table public.houses
  add column if not exists details jsonb not null default '{}'::jsonb;

-- An array or a string here would pass jsonb's own validation and then break
-- every reader that expects `.rooms`. Say object, once, at the boundary.
do $$
begin
  if not exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    where t.relname = 'houses' and c.conname = 'houses_details_object'
  ) then
    alter table public.houses
      add constraint houses_details_object
      check (jsonb_typeof(details) = 'object');
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    where t.relname = 'houses' and c.conname = 'houses_details_size'
  ) then
    alter table public.houses
      add constraint houses_details_size
      check (pg_column_size(details) <= 61440);
  end if;
end $$;

-- Room-by-room listings are the ones a seeker filters for ("show me singles
-- under 80,000"), and `details -> 'rooms'` is where that lives. A GIN index on
-- the whole column answers containment questions without a second table.
create index if not exists houses_details_gin on public.houses using gin (details);

comment on column public.houses.details is
  'Agent-authored spec sheet: { v, rooms[], groups[] }. Shape owned by js/lib/house-spec.js — see supabase/features/house/houses_details.sql.';
