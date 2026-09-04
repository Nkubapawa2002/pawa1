-- ============================================================================
--  offer_details.sql — a spec sheet for a service and for a truck.
--
--  WHY
--  public.houses has carried `details jsonb` for a while, and it is the reason
--  a room can say it has a tiled floor and its own LUKU meter without either
--  fact needing a column. public.services and public.trucks had nothing of the
--  kind: every fact a customer rings to ask about — do you bring your own
--  tools, is there a tarpaulin, is the driver included, will you give me a
--  receipt — had to go into the free-text description, where it is invisible
--  to search, impossible to compare between two providers, and gone the moment
--  the paragraph gets long.
--
--  SHAPE (written by js/pages/agent-services.js and agent-trucks.js, read by
--  js/lib/offer-spec.js):
--
--    services.details = {
--      "v": 1,
--      "includes": ["own_tools", "receipt", "I climb my own scaffold"],
--      "categoryOther": "Borehole drilling" | null
--    }
--
--    trucks.details = {
--      "v": 1,
--      "kit": ["driver", "tarpaulin", "Two spare tyres on long runs"]
--    }
--
--  An entry is either a catalogue key or the provider's own words, and the two
--  are deliberately indistinguishable downstream: a characteristic somebody
--  invented has to read exactly like an offered one or nobody invents any.
--
--  Additive and idempotent. It adds a defaulted column and touches no existing
--  row, no policy and no read path: a build that has never heard of `details`
--  keeps working, and one that has finds '{}' rather than null.
-- ============================================================================

alter table public.services add column if not exists details jsonb not null default '{}'::jsonb;
alter table public.trucks   add column if not exists details jsonb not null default '{}'::jsonb;

comment on column public.services.details is
  'Spec sheet: {v, includes[], categoryOther}. See js/lib/offer-spec.js.';
comment on column public.trucks.details is
  'Spec sheet: {v, kit[]}. See js/lib/offer-spec.js.';
