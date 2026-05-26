-- Pawa Bus Cargo - Supabase schema
-- Run this once in the Supabase SQL editor.

-- Drop in reverse dependency order (safe re-runs)
drop table if exists shipment_messages cascade;
drop table if exists shipments cascade;
drop table if exists agents cascade;
drop table if exists buses cascade;
drop table if exists regions cascade;

-- ==========================================
-- regions
-- ==========================================
create table regions (
  name text primary key
);

-- ==========================================
-- buses
-- ==========================================
create table buses (
  id text primary key,
  name text not null,
  contact text not null,
  routes jsonb not null default '[]'::jsonb,
  created_at timestamptz default now()
);

-- ==========================================
-- agents
-- ==========================================
create table agents (
  id text primary key,
  name text not null,
  phone text not null,
  region text not null references regions(name) on update cascade,
  terminal text,
  buses text[] not null default '{}',
  created_at timestamptz default now()
);

-- ==========================================
-- shipments
-- ==========================================
create table shipments (
  tracking_code text primary key,

  sender_name text not null,
  sender_phone text not null,
  sender_region text not null,

  receiver_name text not null,
  receiver_phone text not null,
  receiver_region text not null,

  product_description text not null,
  product_weight_kg numeric not null,
  product_value_tzs numeric not null default 0,
  insured boolean not null default true,

  bus_name text not null,
  bus_route text not null,
  bus_departure text not null,

  agent_origin_name text,
  agent_origin_phone text,
  agent_destination_name text,
  agent_destination_phone text,

  status text not null default 'Registered'
    check (status in ('Registered','Picked Up','In Transit','Arrived','Delivered')),

  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index shipments_sender_phone_idx on shipments (sender_phone);
create index shipments_receiver_phone_idx on shipments (receiver_phone);
create index shipments_status_idx on shipments (status);

-- ==========================================
-- shipment_messages (communication thread)
-- ==========================================
create table shipment_messages (
  id bigserial primary key,
  tracking_code text not null references shipments(tracking_code) on delete cascade,
  from_role text not null
    check (from_role in ('sender','receiver','agent_origin','agent_destination','system')),
  from_name text not null,
  message text not null,
  created_at timestamptz default now()
);

create index shipment_messages_code_idx on shipment_messages (tracking_code, created_at);

-- ==========================================
-- Touch updated_at trigger
-- ==========================================
create or replace function touch_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_shipments_updated on shipments;
create trigger trg_shipments_updated
  before update on shipments
  for each row execute function touch_updated_at();

-- ==========================================
-- Row-level security
-- DEMO POLICY: public read/write so the static site works without auth.
-- For production, add proper auth and tighten these.
-- ==========================================
alter table regions enable row level security;
alter table buses enable row level security;
alter table agents enable row level security;
alter table shipments enable row level security;
alter table shipment_messages enable row level security;

create policy "regions readable" on regions for select using (true);
create policy "buses readable" on buses for select using (true);
create policy "agents readable" on agents for select using (true);
create policy "shipments readable" on shipments for select using (true);
create policy "shipments insertable" on shipments for insert with check (true);
create policy "shipments updatable" on shipments for update using (true);
create policy "messages readable" on shipment_messages for select using (true);
create policy "messages insertable" on shipment_messages for insert with check (true);

-- ==========================================
-- Realtime: enable for shipments + messages
-- (Also enable in Supabase dashboard: Database > Replication)
-- ==========================================
alter publication supabase_realtime add table shipments;
alter publication supabase_realtime add table shipment_messages;
