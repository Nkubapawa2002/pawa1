-- =====================================================
-- Schema v5b — agent self-service photo update
-- =====================================================

-- Agents can update their own photo by proving they know their phone.
-- security definer bypasses the admin-only RLS on the agents table.
create or replace function update_agent_photo(p_phone text, p_photo_path text)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  n int;
begin
  update agents
  set photo_path = p_photo_path
  where phone = p_phone
     or replace(phone, ' ', '') = replace(p_phone, ' ', '')
     or p_phone = any(phones)
     or replace(p_phone, ' ', '') = any(
          select replace(ph, ' ', '') from unnest(phones) ph
        );
  get diagnostics n = row_count;
  return n > 0;
end;
$$;
