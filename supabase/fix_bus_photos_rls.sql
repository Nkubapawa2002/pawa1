-- ============================================================================
-- Fix: storage RLS policies for the `bus-photos` bucket.
--
-- Symptom: admin tried to add a bus and got
--   "Photo upload failed: new row violates row-level security policy"
-- The bucket exists and is public for reads, but no INSERT/UPDATE/DELETE
-- policy was ever created on storage.objects for it, so authenticated
-- uploads are denied. Pattern mirrors the existing `ride-driver-photos`
-- policies in rides_schema.sql. Idempotent — safe to run multiple times.
-- ============================================================================

-- 1. Public read (matches bucket.public=true; also makes the policy explicit
--    so disabling bucket.public doesn't silently break the gallery).
drop policy if exists "bus photos public read" on storage.objects;
create policy "bus photos public read"
  on storage.objects for select
  using (bucket_id = 'bus-photos');

-- 2. Authenticated users can upload new photos. Admin & tenant dashboards
--    upload through this — the destination table (`buses`) has its own RLS,
--    so only admins/tenants actually get to write the row that references
--    the file.
drop policy if exists "bus photos authenticated insert" on storage.objects;
create policy "bus photos authenticated insert"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'bus-photos');

-- 3. Authenticated update — required because admin.js uploads with
--    `upsert: true`, which translates to INSERT … ON CONFLICT UPDATE.
drop policy if exists "bus photos authenticated update" on storage.objects;
create policy "bus photos authenticated update"
  on storage.objects for update to authenticated
  using (bucket_id = 'bus-photos')
  with check (bucket_id = 'bus-photos');

-- 4. Authenticated delete — for replacing/removing a bus photo.
drop policy if exists "bus photos authenticated delete" on storage.objects;
create policy "bus photos authenticated delete"
  on storage.objects for delete to authenticated
  using (bucket_id = 'bus-photos');
