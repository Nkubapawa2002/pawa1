-- =====================================================================
-- Server-side tracking-code generator that matches the client algorithm
-- in js/tracking-id.js (Crockford base32, 6-char timestamp, 4-char random,
-- single-character Damm-style checksum).
--
-- Format:  TZ-XXX-YYY-AAAAAA-BBBB-C
-- Run in Supabase SQL Editor.
-- =====================================================================

create or replace function public.generate_tracking_code(
  p_origin text,
  p_dest   text
) returns text
language plpgsql
as $$
declare
  alphabet  text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';   -- Crockford base32
  epoch_ms  bigint := 1704067200000;                       -- 2024-01-01 UTC

  v_origin  text;
  v_dest    text;
  v_t       bigint;
  v_ts      text := '';
  v_rand    text := '';
  v_body    text;
  v_check   text;
  i         int;
  acc       int := 0;
  ch        int;
  raw       text;

  region_codes constant jsonb := jsonb_build_object(
    'arusha','ARU','dar es salaam','DAR','dodoma','DOD','geita','GEI',
    'iringa','IRI','kagera','KAG','katavi','KAT','kigoma','KIG',
    'kilimanjaro','KIL','lindi','LIN','manyara','MAN','mara','MAR',
    'mbeya','MBE','morogoro','MOR','mtwara','MTW','mwanza','MWZ',
    'njombe','NJO','pwani','PWA','rukwa','RUK','ruvuma','RUV',
    'shinyanga','SHI','simiyu','SIM','singida','SIN','songwe','SON',
    'tabora','TAB','tanga','TAN','zanzibar','ZNZ','pemba','PEM'
  );
begin
  -- Origin / destination 3-letter code (lookup, then fallback to first 3 alpha)
  v_origin := coalesce(region_codes ->> lower(coalesce(p_origin,'')),
                       upper(regexp_replace(coalesce(p_origin,'XXX'), '[^a-zA-Z]', '', 'g')));
  v_origin := lpad(left(v_origin, 3), 3, 'X');

  v_dest   := coalesce(region_codes ->> lower(coalesce(p_dest,'')),
                       upper(regexp_replace(coalesce(p_dest,'XXX'), '[^a-zA-Z]', '', 'g')));
  v_dest   := lpad(left(v_dest, 3), 3, 'X');

  -- 6-char base32 timestamp (ms since epoch)
  v_t := (extract(epoch from clock_timestamp()) * 1000)::bigint - epoch_ms;
  for i in 1..6 loop
    v_ts := substr(alphabet, (v_t % 32)::int + 1, 1) || v_ts;
    v_t  := v_t / 32;
  end loop;

  -- 4-char random suffix (cryptographically random bytes via pgcrypto)
  perform 1 from pg_extension where extname = 'pgcrypto';
  if not found then
    create extension if not exists pgcrypto;
  end if;
  for i in 1..4 loop
    v_rand := v_rand || substr(alphabet, (get_byte(gen_random_bytes(1), 0) % 32) + 1, 1);
  end loop;

  v_body := 'TZ' || v_origin || v_dest || v_ts || v_rand;

  -- Damm-style checksum (rolling, position-weighted, mod 32)
  acc := 0;
  for i in 1..length(v_body) loop
    ch  := position(substr(v_body, i, 1) in alphabet) - 1;
    if ch >= 0 then
      acc := (acc * 33 + ch + i) % 32;
    end if;
  end loop;
  v_check := substr(alphabet, acc + 1, 1);

  return 'TZ-' || v_origin || '-' || v_dest || '-' || v_ts || '-' || v_rand || '-' || v_check;
end;
$$;

grant execute on function public.generate_tracking_code(text, text) to anon, authenticated, service_role;

-- Optional: book-time tracking code on shipments insert (only if missing)
create or replace function public.shipments_assign_tracking_code()
returns trigger as $$
begin
  if new.tracking_code is null or new.tracking_code = '' then
    new.tracking_code := public.generate_tracking_code(new.sender_region, new.receiver_region);
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_shipments_tracking_code on public.shipments;
create trigger trg_shipments_tracking_code
  before insert on public.shipments
  for each row execute function public.shipments_assign_tracking_code();
