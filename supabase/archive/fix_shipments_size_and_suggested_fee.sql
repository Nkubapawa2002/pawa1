-- ============================================================================
-- Fix: restore product_size_category and product_suggested_fee on shipments.
--
-- Symptom: admin approval of a pending shipment insert failed because the
-- payload referenced these columns but they were never added to the live DB.
-- They are defined in schema_master.sql lines 274-275. Idempotent.
-- ============================================================================

alter table public.shipments
  add column if not exists product_size_category text;

-- Add the CHECK constraint only if it doesn't already exist. Naming it so
-- repeat runs are safe.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'shipments_product_size_category_check'
      and conrelid = 'public.shipments'::regclass
  ) then
    alter table public.shipments
      add constraint shipments_product_size_category_check
      check (product_size_category in ('small','medium','large'));
  end if;
end $$;

alter table public.shipments
  add column if not exists product_suggested_fee numeric(14,2) not null default 0;

notify pgrst, 'reload schema';
