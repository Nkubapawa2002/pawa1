-- =====================================================================
-- Pawa Bus Cargo — Payments schema (v8)
-- Unified payment tracking across all Tanzanian payment methods.
-- Run in Supabase SQL Editor.
-- =====================================================================

-- ----- 1. payments ---------------------------------------------------
create table if not exists public.payments (
  id              uuid primary key default gen_random_uuid(),

  -- Internal reference: ties payment to a booking ticket / shipment code / etc.
  reference       text not null,
  reference_type  text not null
                  check (reference_type in
                    ('booking','shipment','agent_topup','reschedule','other')),

  amount_tzs      numeric(12,2) not null check (amount_tzs > 0),
  currency        text not null default 'TZS',

  customer_name   text,
  customer_phone  text not null,
  customer_email  text,

  -- Specific payment instrument the customer chose
  method          text not null check (method in (
    'mpesa','tigopesa','airtel','halopesa','azampesa',
    'nmb','crdb','nbc','equity','stanbic','other_bank',
    'card','cash','bank_transfer'
  )),

  -- Aggregator/provider that processed it (null for cash)
  provider        text check (provider in
                    ('selcom','clickpesa','azampay','flutterwave',
                     'pesapal','manual','vapi','cash','demo')),

  -- IDs from the provider for reconciliation
  provider_ref    text,         -- aggregator transaction id
  ussd_session    text,         -- USSD-push session id, if applicable
  external_ref    text,         -- telco / bank confirmation number
  payment_url     text,         -- redirect URL for card / bank flows

  status          text not null default 'pending' check (status in (
    'pending',          -- created, awaiting provider
    'awaiting_payment', -- USSD pushed; customer must enter PIN
    'processing',       -- provider working on it
    'completed',        -- confirmed paid
    'failed',           -- failed (insufficient funds / declined / etc)
    'cancelled',        -- user cancelled
    'refunded',         -- refunded after success
    'expired'           -- timed out (no PIN entered, etc.)
  )),

  paid_at         timestamptz,
  expires_at      timestamptz not null default (now() + interval '15 minutes'),

  attempts        int not null default 0,
  error_message   text,
  raw_request     jsonb,
  raw_response    jsonb,
  raw_callback    jsonb,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- One *active* payment per reference at a time (allow refunds/retries to coexist)
create unique index if not exists payments_reference_active_idx
  on public.payments (reference)
  where status in ('pending','awaiting_payment','processing','completed');

create index if not exists payments_status_created_idx
  on public.payments (status, created_at desc);
create index if not exists payments_reference_idx
  on public.payments (reference);
create index if not exists payments_provider_ref_idx
  on public.payments (provider_ref) where provider_ref is not null;
create index if not exists payments_phone_idx
  on public.payments (customer_phone);

-- ----- 2. payment_callbacks (append-only audit log) ------------------
create table if not exists public.payment_callbacks (
  id              bigserial primary key,
  payment_id      uuid references public.payments(id) on delete set null,
  provider        text,
  event_type      text,             -- e.g. 'success','failure','refund'
  signature_ok    boolean default true,
  http_status     int,
  ip_address      text,
  raw_headers     jsonb,
  raw_body        jsonb,
  received_at     timestamptz not null default now()
);

create index if not exists payment_callbacks_payment_idx
  on public.payment_callbacks (payment_id, received_at desc);
create index if not exists payment_callbacks_provider_idx
  on public.payment_callbacks (provider, received_at desc);

-- ----- 3. updated_at touch trigger -----------------------------------
create or replace function public.touch_updated_at_payments()
returns trigger as $$
begin
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_payments_updated on public.payments;
create trigger trg_payments_updated
  before update on public.payments
  for each row execute function public.touch_updated_at_payments();

-- ----- 4. Auto-confirm booking / shipment when payment completes ----
create or replace function public.handle_payment_completion()
returns trigger as $$
begin
  -- Only act on the transition into 'completed'
  if new.status = 'completed' and (old.status is null or old.status <> 'completed') then
    if new.paid_at is null then
      new.paid_at := now();
    end if;

    if new.reference_type = 'booking' then
      update public.bookings
         set status = 'confirmed'
       where ticket_code = new.reference
         and status in ('pending','awaiting_payment');

    elsif new.reference_type = 'reschedule' then
      update public.bookings
         set status = 'confirmed'
       where ticket_code = new.reference
         and status in ('pending','awaiting_payment');

    elsif new.reference_type = 'shipment' then
      -- Mark shipment as paid; status stays at 'Registered' until pickup
      update public.shipments
         set notes = coalesce(notes,'') ||
                     E'\n[paid ' || to_char(now(),'YYYY-MM-DD HH24:MI') ||
                     ' via ' || new.method || ' — ' ||
                     coalesce(new.provider_ref,'manual') || ']'
       where tracking_code = new.reference;
    end if;
  end if;

  -- Refund flow: roll booking back to cancelled
  if new.status = 'refunded' and (old.status is null or old.status <> 'refunded') then
    if new.reference_type in ('booking','reschedule') then
      update public.bookings
         set status = 'cancelled', cancelled_at = coalesce(cancelled_at, now())
       where ticket_code = new.reference;
    end if;
  end if;

  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_payment_complete on public.payments;
create trigger trg_payment_complete
  before update on public.payments
  for each row execute function public.handle_payment_completion();

-- ----- 5. RLS --------------------------------------------------------
alter table public.payments          enable row level security;
alter table public.payment_callbacks enable row level security;

-- Customers (anon) may insert and read by reference
drop policy if exists "anon_insert_payments" on public.payments;
create policy "anon_insert_payments"
  on public.payments for insert to anon, authenticated with check (true);

drop policy if exists "anon_select_payments" on public.payments;
create policy "anon_select_payments"
  on public.payments for select to anon, authenticated using (true);

-- Edge function (service-role) writes updates; anon may NOT update directly
drop policy if exists "service_update_payments" on public.payments;
create policy "service_update_payments"
  on public.payments for update to service_role using (true) with check (true);

-- Admins may also update via dashboard
drop policy if exists "admin_update_payments" on public.payments;
create policy "admin_update_payments"
  on public.payments for update to authenticated
  using (exists (select 1 from public.admins a where a.email = auth.email()))
  with check (exists (select 1 from public.admins a where a.email = auth.email()));

-- Audit log: service role only
drop policy if exists "service_insert_callbacks" on public.payment_callbacks;
create policy "service_insert_callbacks"
  on public.payment_callbacks for insert to service_role with check (true);

drop policy if exists "admin_select_callbacks" on public.payment_callbacks;
create policy "admin_select_callbacks"
  on public.payment_callbacks for select to authenticated
  using (exists (select 1 from public.admins a where a.email = auth.email()));

-- ----- 6. Realtime publication --------------------------------------
do $$ begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'payments'
  ) then
    alter publication supabase_realtime add table public.payments;
  end if;
end $$;

-- ----- 7. Helper view for admin dashboard ---------------------------
create or replace view public.payments_overview as
select
  p.id,
  p.reference,
  p.reference_type,
  p.amount_tzs,
  p.method,
  p.provider,
  p.status,
  p.customer_name,
  p.customer_phone,
  p.provider_ref,
  p.external_ref,
  p.paid_at,
  p.created_at,
  case
    when p.reference_type in ('booking','reschedule')
      then (select b.bus_name || ' · ' || b.origin || ' → ' || b.destination
              from public.bookings b where b.ticket_code = p.reference)
    when p.reference_type = 'shipment'
      then (select s.sender_name || ' → ' || s.receiver_name
              from public.shipments s where s.tracking_code = p.reference)
    else null
  end as link_summary
from public.payments p
order by p.created_at desc;

grant select on public.payments_overview to anon, authenticated;
