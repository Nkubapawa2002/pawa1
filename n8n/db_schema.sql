-- ============================================================
-- BUS TZ PAWA — Postgres schema for n8n workflows
-- Run once on your Postgres database before importing workflows
-- ============================================================

CREATE TABLE IF NOT EXISTS routes (
  id            SERIAL PRIMARY KEY,
  origin        TEXT NOT NULL,
  destination   TEXT NOT NULL,
  base_price    INTEGER NOT NULL,            -- TZS
  duration_hrs  NUMERIC(4,1) NOT NULL,
  active        BOOLEAN DEFAULT TRUE,
  UNIQUE (origin, destination)
);

CREATE TABLE IF NOT EXISTS buses (
  id           SERIAL PRIMARY KEY,
  plate        TEXT UNIQUE NOT NULL,
  class        TEXT CHECK (class IN ('economy','semi-luxury','luxury')),
  seat_count   INTEGER NOT NULL DEFAULT 50,
  photo_urls   TEXT[]            -- public CDN URLs
);

CREATE TABLE IF NOT EXISTS trips (
  id              SERIAL PRIMARY KEY,
  route_id        INTEGER REFERENCES routes(id),
  bus_id          INTEGER REFERENCES buses(id),
  departure_at    TIMESTAMPTZ NOT NULL,
  price           INTEGER NOT NULL,
  status          TEXT DEFAULT 'SCHEDULED'  -- SCHEDULED|DEPARTED|ARRIVED|CANCELLED
);

CREATE INDEX IF NOT EXISTS idx_trips_dep ON trips (departure_at);

CREATE TABLE IF NOT EXISTS seats (
  id           SERIAL PRIMARY KEY,
  trip_id      INTEGER REFERENCES trips(id) ON DELETE CASCADE,
  seat_number  INTEGER NOT NULL,
  is_window    BOOLEAN DEFAULT FALSE,
  status       TEXT DEFAULT 'AVAILABLE',    -- AVAILABLE|HELD|CONFIRMED|OCCUPIED
  UNIQUE (trip_id, seat_number)
);

CREATE INDEX IF NOT EXISTS idx_seats_trip ON seats (trip_id, status);

CREATE TABLE IF NOT EXISTS bookings (
  id                       SERIAL PRIMARY KEY,
  ref                      TEXT UNIQUE NOT NULL,        -- e.g. PAWA-2026-00001
  trip_id                  INTEGER REFERENCES trips(id),
  seat_id                  INTEGER REFERENCES seats(id),
  passenger_name           TEXT NOT NULL,
  phone                    TEXT NOT NULL,               -- registered phone (anchor)
  alt_payment_phone        TEXT,
  id_type                  TEXT,
  id_number                TEXT,
  amount                   INTEGER NOT NULL,
  payment_method           TEXT,                        -- mpesa|tigopesa|airtel|halopesa|azampesa|bank|cash
  payment_provider_ref     TEXT,
  status                   TEXT NOT NULL DEFAULT 'HELD',-- HELD|CONFIRMED|CANCELLED|COMPLETED|EXPIRED
  hold_expires_at          TIMESTAMPTZ,
  paid_at                  TIMESTAMPTZ,
  cancelled_at             TIMESTAMPTZ,
  created_at               TIMESTAMPTZ DEFAULT NOW(),
  -- lifecycle flags so cron jobs don't re-send messages
  reminder_sent            BOOLEAN DEFAULT FALSE,
  midtrip_sent             BOOLEAN DEFAULT FALSE,
  feedback_sent            BOOLEAN DEFAULT FALSE,
  welcome_sent             BOOLEAN DEFAULT FALSE,
  retarget_sent            BOOLEAN DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings (status);
CREATE INDEX IF NOT EXISTS idx_bookings_phone  ON bookings (phone);

CREATE TABLE IF NOT EXISTS payments (
  id            SERIAL PRIMARY KEY,
  booking_ref   TEXT REFERENCES bookings(ref),
  provider      TEXT,
  txn_ref       TEXT UNIQUE,
  amount        INTEGER,
  status        TEXT,                       -- PENDING|SUCCESS|FAILED|INSUFFICIENT_FUNDS
  raw_callback  JSONB,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS complaints (
  id            SERIAL PRIMARY KEY,
  booking_ref   TEXT,
  phone         TEXT,
  summary       TEXT,
  status        TEXT DEFAULT 'OPEN',
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Districts that customers requested but we don't yet serve
CREATE TABLE IF NOT EXISTS service_gaps (
  id              SERIAL PRIMARY KEY,
  district        TEXT NOT NULL,
  region          TEXT,
  request_count   INTEGER DEFAULT 1,
  last_requested  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (district)
);

-- Static lookup: remote district -> nearest serviced hub
CREATE TABLE IF NOT EXISTS nearest_hubs (
  district     TEXT PRIMARY KEY,
  hub          TEXT NOT NULL,
  alt_hub      TEXT,
  notes        TEXT
);

-- Seed nearest hubs (subset — extend per spec table)
INSERT INTO nearest_hubs (district, hub, alt_hub, notes) VALUES
  ('Longido','Arusha City',NULL,NULL),
  ('Monduli','Arusha City',NULL,NULL),
  ('Ngorongoro','Karatu','Arusha City',NULL),
  ('Rombo','Moshi',NULL,NULL),
  ('Siha','Moshi',NULL,NULL),
  ('Mwanga','Moshi','Tanga',NULL),
  ('Same','Moshi','Tanga',NULL),
  ('Lushoto','Korogwe','Tanga',NULL),
  ('Handeni','Korogwe','Morogoro',NULL),
  ('Mafia','Kibiti',NULL,'Advise water transport to mainland'),
  ('Rufiji','Kibiti','Dar es Salaam',NULL),
  ('Kilombero','Ifakara','Morogoro',NULL),
  ('Ulanga','Ifakara',NULL,NULL),
  ('Kisarawe','Dar es Salaam',NULL,NULL),
  ('Bahi','Dodoma',NULL,NULL),
  ('Chamwino','Dodoma',NULL,NULL),
  ('Kondoa','Dodoma','Singida',NULL),
  ('Mkalama','Singida',NULL,NULL),
  ('Ikungi','Singida',NULL,NULL),
  ('Iramba','Singida',NULL,NULL),
  ('Kaliua','Tabora',NULL,NULL),
  ('Sikonge','Tabora',NULL,NULL),
  ('Ukerewe','Mwanza',NULL,'Advise ferry first'),
  ('Chato','Geita Town','Biharamulo',NULL),
  ('Kyerwa','Bukoba',NULL,NULL),
  ('Ngara','Bukoba',NULL,NULL),
  ('Butiama','Musoma',NULL,NULL),
  ('Rorya','Musoma',NULL,NULL),
  ('Serengeti','Musoma','Bunda',NULL),
  ('Itilima','Bariadi','Shinyanga',NULL),
  ('Meatu','Bariadi','Shinyanga',NULL),
  ('Kishapu','Shinyanga',NULL,NULL),
  ('Kilolo','Iringa',NULL,NULL),
  ('Mufindi','Iringa','Makambako',NULL),
  ('Makete','Njombe',NULL,NULL),
  ('Ludewa','Njombe','Songea',NULL),
  ('Wanging''ombe','Njombe',NULL,NULL),
  ('Chunya','Mbeya',NULL,NULL),
  ('Kyela','Mbeya',NULL,NULL),
  ('Busokelo','Mbeya',NULL,NULL),
  ('Mbarali','Mbeya','Iringa',NULL),
  ('Kalambo','Sumbawanga',NULL,NULL),
  ('Nkasi','Sumbawanga',NULL,NULL),
  ('Mlele','Mpanda',NULL,NULL),
  ('Nsimbo','Mpanda',NULL,NULL),
  ('Ileje','Tunduma','Mbeya',NULL),
  ('Momba','Tunduma','Mbeya',NULL),
  ('Nyasa','Songea',NULL,NULL),
  ('Namtumbo','Songea',NULL,NULL),
  ('Madaba','Songea',NULL,NULL),
  ('Tunduru','Songea','Masasi',NULL),
  ('Kakonko','Kasulu','Kigoma',NULL),
  ('Buhigwe','Kasulu','Kigoma',NULL),
  ('Kibondo','Kasulu',NULL,NULL),
  ('Uvinza','Kigoma','Tabora',NULL),
  ('Nachingwea','Masasi','Lindi',NULL),
  ('Ruangwa','Lindi',NULL,NULL),
  ('Liwale','Lindi','Songea',NULL),
  ('Kilwa','Lindi',NULL,NULL),
  ('Nanyumbu','Masasi','Mtwara',NULL),
  ('Newala','Mtwara',NULL,NULL),
  ('Tandahimba','Mtwara',NULL,NULL)
ON CONFLICT (district) DO NOTHING;

-- ============================================================
-- Seed a couple of routes / trips so workflows have data to query
-- ============================================================
INSERT INTO routes (origin, destination, base_price, duration_hrs) VALUES
  ('Dar es Salaam','Mbeya', 30000, 10),
  ('Dar es Salaam','Arusha',35000,  9),
  ('Dar es Salaam','Mwanza',45000, 13),
  ('Arusha','Moshi',          7000,  1.5)
ON CONFLICT (origin, destination) DO NOTHING;
