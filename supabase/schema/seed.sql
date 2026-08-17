-- Pawa Bus Cargo - Seed data
-- Run after schema.sql

-- ==========================================
-- Regions (Tanzania mainland)
-- ==========================================
insert into regions (name) values
  ('Arusha'),('Dar es Salaam'),('Dodoma'),('Geita'),('Iringa'),
  ('Kagera'),('Katavi'),('Kigoma'),('Kilimanjaro'),('Lindi'),
  ('Manyara'),('Mara'),('Mbeya'),('Morogoro'),('Mtwara'),
  ('Mwanza'),('Njombe'),('Pwani'),('Rukwa'),('Ruvuma'),
  ('Shinyanga'),('Simiyu'),('Singida'),('Songwe'),('Tabora'),('Tanga')
on conflict (name) do nothing;

-- ==========================================
-- Buses
-- ==========================================
insert into buses (id, name, contact, routes) values
('BUS001','Simba Coach','+255 712 111 111', '[
  {"from":"Dar es Salaam","to":"Mwanza","departure":"06:00","duration_hours":18},
  {"from":"Mwanza","to":"Dar es Salaam","departure":"06:00","duration_hours":18}
]'::jsonb),
('BUS002','Dar Express','+255 712 222 222', '[
  {"from":"Dar es Salaam","to":"Arusha","departure":"07:00","duration_hours":10},
  {"from":"Dar es Salaam","to":"Dodoma","departure":"08:30","duration_hours":6},
  {"from":"Dar es Salaam","to":"Mtwara","departure":"06:30","duration_hours":8},
  {"from":"Dar es Salaam","to":"Tanga","departure":"09:00","duration_hours":5},
  {"from":"Dar es Salaam","to":"Morogoro","departure":"10:00","duration_hours":3}
]'::jsonb),
('BUS003','Kilimanjaro Express','+255 754 333 333', '[
  {"from":"Dar es Salaam","to":"Kilimanjaro","departure":"06:00","duration_hours":9},
  {"from":"Dar es Salaam","to":"Arusha","departure":"06:30","duration_hours":10},
  {"from":"Arusha","to":"Dar es Salaam","departure":"07:00","duration_hours":10}
]'::jsonb),
('BUS004','Tahmeed','+255 765 444 444', '[
  {"from":"Dar es Salaam","to":"Arusha","departure":"07:30","duration_hours":10},
  {"from":"Tanga","to":"Arusha","departure":"08:00","duration_hours":6},
  {"from":"Arusha","to":"Manyara","departure":"09:00","duration_hours":3}
]'::jsonb),
('BUS005','Shabiby Line','+255 786 555 555', '[
  {"from":"Dar es Salaam","to":"Dodoma","departure":"07:00","duration_hours":6},
  {"from":"Dodoma","to":"Singida","departure":"13:00","duration_hours":4},
  {"from":"Dodoma","to":"Tabora","departure":"06:00","duration_hours":8}
]'::jsonb),
('BUS006','Sumry High Class','+255 712 666 666', '[
  {"from":"Dar es Salaam","to":"Mbeya","departure":"05:30","duration_hours":14},
  {"from":"Dar es Salaam","to":"Iringa","departure":"07:00","duration_hours":9},
  {"from":"Mbeya","to":"Dar es Salaam","departure":"06:00","duration_hours":14}
]'::jsonb),
('BUS007','Mwanza Bus','+255 754 777 777', '[
  {"from":"Mwanza","to":"Tabora","departure":"07:00","duration_hours":7},
  {"from":"Mwanza","to":"Kagera","departure":"08:00","duration_hours":6},
  {"from":"Mwanza","to":"Kigoma","departure":"06:00","duration_hours":12}
]'::jsonb),
('BUS008','Mohamed Trans','+255 765 888 888', '[
  {"from":"Dar es Salaam","to":"Mbeya","departure":"06:30","duration_hours":14},
  {"from":"Mbeya","to":"Iringa","departure":"08:00","duration_hours":4}
]'::jsonb),
('BUS009','Mtwara Express','+255 786 999 999', '[
  {"from":"Dar es Salaam","to":"Mtwara","departure":"07:00","duration_hours":8},
  {"from":"Mtwara","to":"Lindi","departure":"13:00","duration_hours":2}
]'::jsonb),
('BUS010','Adventure Connection','+255 712 010 101', '[
  {"from":"Mwanza","to":"Kigoma","departure":"07:00","duration_hours":12},
  {"from":"Kigoma","to":"Kagera","departure":"08:00","duration_hours":10}
]'::jsonb)
on conflict (id) do update set
  name = excluded.name,
  contact = excluded.contact,
  routes = excluded.routes;

-- ==========================================
-- Agents
-- ==========================================
insert into agents (id, name, phone, region, terminal, buses) values
('AG001','Juma Hassan','+255 712 345 678','Dar es Salaam','Ubungo Bus Terminal',
  ARRAY['Simba Coach','Dar Express','Kilimanjaro Express']),
('AG002','Grace Kileo','+255 754 111 222','Mwanza','Nyegezi Bus Stand',
  ARRAY['Simba Coach','Mwanza Bus']),
('AG003','Salim Mohamed','+255 765 333 444','Arusha','Arusha Central Bus Stand',
  ARRAY['Kilimanjaro Express','Dar Express','Tahmeed']),
('AG004','Neema Mushi','+255 786 555 666','Kilimanjaro','Moshi Bus Terminal',
  ARRAY['Kilimanjaro Express','Tahmeed']),
('AG005','Ramadhani Said','+255 712 777 888','Dodoma','Dodoma Bus Terminal',
  ARRAY['Shabiby Line','Dar Express']),
('AG006','Joyce Mwakasege','+255 754 999 000','Mbeya','Mbeya Bus Terminal',
  ARRAY['Sumry High Class','Mohamed Trans']),
('AG007','Hamisi Juma','+255 765 121 212','Tanga','Tanga Bus Stand',
  ARRAY['Tahmeed','Dar Express']),
('AG008','Asha Mwinyi','+255 786 232 323','Morogoro','Msamvu Bus Terminal',
  ARRAY['Shabiby Line','Dar Express','Sumry High Class']),
('AG009','Daniel Mollel','+255 712 343 434','Iringa','Iringa Bus Stand',
  ARRAY['Sumry High Class','Mohamed Trans']),
('AG010','Fatuma Ally','+255 754 454 545','Tabora','Tabora Bus Terminal',
  ARRAY['Mwanza Bus','Shabiby Line']),
('AG011','Emmanuel Lwoga','+255 765 565 656','Kigoma','Kigoma Bus Stand',
  ARRAY['Mwanza Bus','Adventure Connection']),
('AG012','Rehema Bakari','+255 786 676 767','Mtwara','Mtwara Bus Terminal',
  ARRAY['Mtwara Express','Dar Express']),
('AG013','John Macha','+255 712 787 878','Kagera','Bukoba Bus Stand',
  ARRAY['Mwanza Bus','Adventure Connection']),
('AG014','Mariam Selemani','+255 754 898 989','Singida','Singida Bus Terminal',
  ARRAY['Shabiby Line','Dar Express']),
('AG015','Peter Massawe','+255 765 909 091','Manyara','Babati Bus Stand',
  ARRAY['Kilimanjaro Express','Tahmeed'])
on conflict (id) do update set
  name = excluded.name,
  phone = excluded.phone,
  region = excluded.region,
  terminal = excluded.terminal,
  buses = excluded.buses;

-- ==========================================
-- Sample shipments
-- ==========================================
insert into shipments (
  tracking_code, sender_name, sender_phone, sender_region,
  receiver_name, receiver_phone, receiver_region,
  product_description, product_weight_kg, product_value_tzs, insured,
  bus_name, bus_route, bus_departure,
  agent_origin_name, agent_origin_phone,
  agent_destination_name, agent_destination_phone,
  status
) values
('TZ-DAR-MWZ-20260428-001',
  'Asha Mwakalinga','+255 712 000 001','Dar es Salaam',
  'Peter Mushi','+255 712 000 002','Mwanza',
  'Clothing parcel', 15, 450000, true,
  'Simba Coach','Dar es Salaam → Mwanza','2026-04-28 06:00',
  'Juma Hassan','+255 712 345 678',
  'Grace Kileo','+255 754 111 222',
  'Delivered'),
('TZ-DAR-ARU-20260429-002',
  'Hassan Mfaume','+255 712 000 003','Dar es Salaam',
  'Lucy Mollel','+255 712 000 004','Arusha',
  'Electronics box', 8, 1200000, true,
  'Kilimanjaro Express','Dar es Salaam → Arusha','2026-04-29 06:30',
  'Juma Hassan','+255 712 345 678',
  'Salim Mohamed','+255 765 333 444',
  'In Transit'),
('TZ-MBE-DAR-20260429-003',
  'Joyce Mwakasege','+255 754 999 000','Mbeya',
  'Mariam Hassan','+255 712 000 005','Dar es Salaam',
  'Avocado crate (50kg)', 50, 200000, true,
  'Sumry High Class','Mbeya → Dar es Salaam','2026-04-29 06:00',
  'Joyce Mwakasege','+255 754 999 000',
  'Juma Hassan','+255 712 345 678',
  'Picked Up')
on conflict (tracking_code) do nothing;
