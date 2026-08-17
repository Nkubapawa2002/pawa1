-- ============================================================================
-- Administrative-area columns for houses & trucks: region → district → ward.
--
-- Each listing is auto-classified into the Tanzanian admin hierarchy from its
-- map pin (reverse geocode) at registration, so a searcher who types a region,
-- district OR ward sees every listing registered in that exact area.
-- Idempotent — safe to re-run.
-- ============================================================================

alter table public.houses add column if not exists district text;
alter table public.houses add column if not exists ward     text;
alter table public.trucks add column if not exists district text;
alter table public.trucks add column if not exists ward     text;

create index if not exists houses_district_idx on public.houses (district);
create index if not exists houses_ward_idx     on public.houses (ward);
create index if not exists trucks_district_idx on public.trucks (district);
create index if not exists trucks_ward_idx     on public.trucks (ward);
