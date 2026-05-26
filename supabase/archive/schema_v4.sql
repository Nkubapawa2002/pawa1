-- =====================================================
-- Pawa Bus Cargo - Schema v4
-- Multiple phone numbers, verified bus operator info, seat booking
-- =====================================================

-- ---------- 1. Multiple phones for buses (with WhatsApp flag + label) ----------
alter table buses add column if not exists contacts jsonb not null default '[]'::jsonb;
alter table buses add column if not exists website text;
alter table buses add column if not exists hq text;
alter table buses add column if not exists year_founded int;
alter table buses add column if not exists seats_total int not null default 50;
alter table buses add column if not exists fare_per_km numeric not null default 80; -- TZS / km, rough

-- Backfill: if contacts is empty but contact exists, build a single-entry array
update buses
set contacts = jsonb_build_array(
  jsonb_build_object('label','Main','number',contact,'whatsapp',true)
)
where contact is not null and (contacts is null or jsonb_array_length(contacts) = 0);

-- ---------- 2. Multiple phones for agents ----------
alter table agents add column if not exists phones text[] not null default '{}';
update agents set phones = array[phone] where phones = '{}' and phone is not null;

alter table agent_applications add column if not exists phones text[] not null default '{}';

-- ---------- 3. Bookings (seat reservation simulation) ----------
create table if not exists bookings (
  id bigserial primary key,
  ticket_code text unique not null,
  bus_id text not null references buses(id),
  bus_name text not null,
  origin text not null,
  destination text not null,
  travel_date date not null,
  departure_time text not null,
  seat_number int not null check (seat_number between 1 and 80),
  passenger_name text not null,
  passenger_phone text not null,
  passenger_id_no text,
  fare_tzs numeric not null default 0,
  status text not null default 'confirmed'
    check (status in ('pending','confirmed','boarded','cancelled')),
  notes text,
  created_at timestamptz default now(),
  unique (bus_id, travel_date, departure_time, seat_number)
);

create index if not exists bookings_phone_idx on bookings (passenger_phone);
create index if not exists bookings_bus_date_idx on bookings (bus_id, travel_date);

alter table bookings enable row level security;

drop policy if exists "bookings readable"   on bookings;
create policy "bookings readable"   on bookings for select using (true);

drop policy if exists "bookings insertable" on bookings;
create policy "bookings insertable" on bookings for insert with check (true);

drop policy if exists "bookings admin update" on bookings;
create policy "bookings admin update" on bookings for update using (is_admin()) with check (is_admin());

-- Realtime
do $$ begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'bookings'
  ) then
    alter publication supabase_realtime add table bookings;
  end if;
end $$;

-- ---------- 4. Update existing buses with verified public info ----------
-- Sources: bookaway.com, tiketi.com, safaribay.net, maasaitravel.com, kilimanjaroexpress.com, shabiby.co.tz, aboodbus.co.tz

update buses set
  contacts = '[
    {"label":"Booking — Dodoma","number":"+255 654 777 773","whatsapp":true},
    {"label":"Booking — Dar","number":"+255 654 777 774","whatsapp":true},
    {"label":"Booking — Arusha","number":"+255 719 777 779","whatsapp":true},
    {"label":"Booking — Moshi","number":"+255 757 594 242","whatsapp":false},
    {"label":"Booking — Morogoro","number":"+255 715 422 222","whatsapp":true}
  ]'::jsonb,
  hq = 'Dodoma',
  website = 'https://shabiby.co.tz',
  about = 'Luxury intercity service. HQ Dodoma. Strong network across central + northern Tanzania.'
where id = 'BUS005';

update buses set
  contacts = '[
    {"label":"Shekilango (Dar)","number":"+255 752 400 026","whatsapp":true},
    {"label":"Kigamboni (Dar)","number":"+255 762 938 511","whatsapp":false},
    {"label":"Moshi","number":"+255 767 213 231","whatsapp":true},
    {"label":"Arusha","number":"+255 715 144 301","whatsapp":true},
    {"label":"Arusha 2","number":"+255 767 334 301","whatsapp":false}
  ]'::jsonb,
  website = 'https://kilimanjaroexpress.com',
  about = '20+ years operating the Dar–Arusha–Moshi corridor. Multiple daily VIP departures.'
where id = 'BUS003';

update buses set
  contacts = '[
    {"label":"Shekilango (Dar)","number":"+255 729 356 561","whatsapp":true},
    {"label":"Cross-border desk","number":"+254 706 445 114","whatsapp":false}
  ]'::jsonb,
  website = 'https://www.tahmeedexpress.com',
  hq = 'Cross-border (Nairobi / Dar)',
  about = 'Cross-border luxury coach: Dar – Tanga – Mombasa – Nairobi.'
where id = 'BUS004';

-- ---------- 5. New verified operators ----------
insert into buses (id, name, contact, contacts, routes, about, hq, website, year_founded, verified, photo_path)
values
('BUS011', 'Abood Bus', '+255 748 771 551',
  '[
    {"label":"Customer Care","number":"+255 748 771 551","whatsapp":true},
    {"label":"Bookings","number":"+255 715 888 999","whatsapp":true},
    {"label":"Bookings 2","number":"+255 784 444 555","whatsapp":false}
  ]'::jsonb,
  '[
    {"from":"Dar es Salaam","to":"Morogoro","departure":"06:00","duration_hours":3},
    {"from":"Morogoro","to":"Dar es Salaam","departure":"06:00","duration_hours":3},
    {"from":"Dar es Salaam","to":"Mbeya","departure":"05:30","duration_hours":14},
    {"from":"Mbeya","to":"Dar es Salaam","departure":"05:30","duration_hours":14},
    {"from":"Dar es Salaam","to":"Arusha","departure":"06:30","duration_hours":10},
    {"from":"Arusha","to":"Dar es Salaam","departure":"06:30","duration_hours":10},
    {"from":"Dar es Salaam","to":"Mwanza","departure":"06:00","duration_hours":18}
  ]'::jsonb,
  'Founded 1986, HQ Morogoro. ~1M passengers/year — Tanzania''s largest intercity bus provider.',
  'Msamvu, Morogoro', 'https://aboodbus.co.tz', 1986, true,
  'aleksey-cherenkevich-ydleUv2q2Y4-unsplash.jpg'),

('BUS012', 'Modern Coast Bus', '+255 787 247 585',
  '[
    {"label":"Mapipa (Dar)","number":"+255 787 247 585","whatsapp":true},
    {"label":"Mapipa (Dar) 2","number":"+255 685 242 288","whatsapp":true},
    {"label":"Customer Care (Regional)","number":"+254 709 897 000","whatsapp":false}
  ]'::jsonb,
  '[
    {"from":"Dar es Salaam","to":"Arusha","departure":"06:00","duration_hours":10},
    {"from":"Arusha","to":"Dar es Salaam","departure":"06:00","duration_hours":10},
    {"from":"Dar es Salaam","to":"Tanga","departure":"08:00","duration_hours":5},
    {"from":"Tanga","to":"Dar es Salaam","departure":"08:00","duration_hours":5}
  ]'::jsonb,
  'Cross-border premium coach across Tanzania, Kenya, Uganda, and Rwanda.',
  'Mapipa, Dar es Salaam', 'https://moderncoast.com', 2003, true,
  'elizabeth-lies-LUP8Tnwy7Ro-unsplash.jpg'),

('BUS013', 'BM Coach', '+255 754 285 285',
  '[
    {"label":"HQ Morogoro","number":"+255 754 285 285","whatsapp":true}
  ]'::jsonb,
  '[
    {"from":"Dar es Salaam","to":"Arusha","departure":"06:30","duration_hours":10},
    {"from":"Dar es Salaam","to":"Iringa","departure":"07:00","duration_hours":9},
    {"from":"Iringa","to":"Dar es Salaam","departure":"07:00","duration_hours":9},
    {"from":"Dar es Salaam","to":"Mbeya","departure":"06:00","duration_hours":14}
  ]'::jsonb,
  'Founded 1996. 100+ bus fleet, HQ Morogoro. Daily Dar–Arusha–Iringa–Mbeya departures.',
  'Morogoro', 'https://www.bmcoach.co.tz', 1996, true,
  'habib-ilmi-nTwn_5qYWgw-unsplash.jpg'),

('BUS014', 'Asante Rabi Express', '+255 745 200 200',
  '[
    {"label":"Bookings","number":"+255 745 200 200","whatsapp":true}
  ]'::jsonb,
  '[
    {"from":"Dar es Salaam","to":"Arusha","departure":"06:00","duration_hours":10},
    {"from":"Arusha","to":"Mwanza","departure":"06:00","duration_hours":12},
    {"from":"Moshi","to":"Mwanza","departure":"06:00","duration_hours":13},
    {"from":"Mwanza","to":"Moshi","departure":"06:00","duration_hours":13}
  ]'::jsonb,
  'Online-first booking platform. Northern + Lake-zone connections.',
  'Dar es Salaam', 'https://asanterabi.co.tz', 2018, true,
  'hardial-aujla-rJ4tFb4F-DE-unsplash.jpg'),

('BUS015', 'Loliondo Coach', '+255 786 600 600',
  '[
    {"label":"Customer Care","number":"+255 786 600 600","whatsapp":true}
  ]'::jsonb,
  '[
    {"from":"Dar es Salaam","to":"Mwanza","departure":"06:00","duration_hours":18},
    {"from":"Mwanza","to":"Dar es Salaam","departure":"06:00","duration_hours":18},
    {"from":"Dar es Salaam","to":"Bukoba","departure":"06:00","duration_hours":24},
    {"from":"Bukoba","to":"Dar es Salaam","departure":"06:00","duration_hours":24}
  ]'::jsonb,
  'Long-haul lake-zone specialist with safe overnight service.',
  'Dar es Salaam', 'https://www.loliondocoach.co.tz', 2008, true,
  'jalal-kelink-ugzSzSG7CFA-unsplash.jpg')

on conflict (id) do update set
  contacts = excluded.contacts,
  routes = excluded.routes,
  about = excluded.about,
  hq = excluded.hq,
  website = excluded.website,
  year_founded = excluded.year_founded,
  verified = excluded.verified,
  photo_path = excluded.photo_path;
