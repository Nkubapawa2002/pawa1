-- ============================================================================
--  Fix: "new row for relation meet_rooms violates check constraint
--        meet_rooms_purpose_check"  (meet.html + live property viewing / locate)
-- ----------------------------------------------------------------------------
--  Cause: the ORIGINAL meet schema (supabase/archive/meet_schema.sql) shipped
--    purpose text default 'meet' check (purpose in ('meet','delivery','pickup','handoff'))
--  but the app's purpose values are now 'viewing' (the DEFAULT in the UI),
--  'service', 'agent', 'handover', 'meet'. schema_master.sql §19 already makes
--  `purpose` free-form text with NO check — but `create table if not exists`
--  never alters an already-deployed table, so the stale constraint lingers and
--  rejects every non-'meet' room (i.e. the default "Live property viewing").
--
--  This migration brings the live DB in line with schema_master.sql.
--  Idempotent — safe to re-run. Paste into Supabase SQL editor, or:
--    PG_PASSWORD=… node scripts/run_sql.mjs supabase/fix_meet_rooms_purpose.sql
-- ============================================================================

-- Drop by its known name (Postgres auto-named it <table>_<col>_check).
alter table public.meet_rooms drop constraint if exists meet_rooms_purpose_check;

-- Belt-and-suspenders: if it was ever recreated under a different name, drop any
-- remaining CHECK constraint that references only the `purpose` column.
do $$
declare c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'meet_rooms'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%purpose%'
  loop
    execute format('alter table public.meet_rooms drop constraint %I', c.conname);
  end loop;
end $$;

-- Verify: should return zero rows.
select con.conname, pg_get_constraintdef(con.oid) as def
from pg_constraint con
join pg_class rel on rel.oid = con.conrelid
join pg_namespace nsp on nsp.oid = rel.relnamespace
where nsp.nspname = 'public' and rel.relname = 'meet_rooms'
  and con.contype = 'c' and pg_get_constraintdef(con.oid) ilike '%purpose%';
