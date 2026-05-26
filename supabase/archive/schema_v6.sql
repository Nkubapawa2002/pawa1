-- =====================================================
-- Pawa Bus Cargo - Schema v6
-- Server-side tracking-code generator (collision-proof)
-- =====================================================

-- Sequence guarantees uniqueness across concurrent inserts.
create sequence if not exists tracking_code_seq;

-- generate_tracking_code('Dar es Salaam', 'Mwanza')
--   → 'TZ-DAR-MWA-20260501-0001'
create or replace function generate_tracking_code(p_origin text, p_dest text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_origin text := upper(regexp_replace(coalesce(p_origin, ''), '[^A-Za-z]', '', 'g'));
  v_dest   text := upper(regexp_replace(coalesce(p_dest,   ''), '[^A-Za-z]', '', 'g'));
  v_date   text := to_char(now() at time zone 'Africa/Dar_es_Salaam', 'YYYYMMDD');
  v_seq    int  := nextval('tracking_code_seq');
begin
  if length(v_origin) < 3 or length(v_dest) < 3 then
    raise exception 'origin and destination must each contain at least 3 letters';
  end if;

  return format('TZ-%s-%s-%s-%s',
    substring(v_origin from 1 for 3),
    substring(v_dest   from 1 for 3),
    v_date,
    lpad(v_seq::text, 4, '0')
  );
end;
$$;

-- Allow anyone to call it (the website registers shipments anonymously)
grant execute on function generate_tracking_code(text, text) to anon, authenticated;
