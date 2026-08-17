-- ============================================================================
-- regions_seed.sql — all 31 regions of the United Republic of Tanzania
-- ============================================================================
-- 26 Mainland (Tanganyika) + 5 Zanzibar (Unguja & Pemba) regions. The agent
-- "Where do you operate?" prompt and every region dropdown read public.regions,
-- so Zanzibar agents could not pick their region until these were seeded.
--
-- Idempotent — safe to re-run. Existing rows are left untouched.
-- ----------------------------------------------------------------------------
insert into public.regions (name) values
  -- Mainland
  ('Arusha'), ('Dar es Salaam'), ('Dodoma'), ('Geita'), ('Iringa'),
  ('Kagera'), ('Katavi'), ('Kigoma'), ('Kilimanjaro'), ('Lindi'),
  ('Manyara'), ('Mara'), ('Mbeya'), ('Morogoro'), ('Mtwara'),
  ('Mwanza'), ('Njombe'), ('Pwani'), ('Rukwa'), ('Ruvuma'),
  ('Shinyanga'), ('Simiyu'), ('Singida'), ('Songwe'), ('Tabora'), ('Tanga'),
  -- Zanzibar (Unguja & Pemba)
  ('Kaskazini Unguja'), ('Kusini Unguja'), ('Mjini Magharibi'),
  ('Kaskazini Pemba'), ('Kusini Pemba')
on conflict (name) do nothing;
