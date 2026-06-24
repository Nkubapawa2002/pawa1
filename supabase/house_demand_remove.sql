-- ============================================================================
-- house_demand_remove.sql — let a seeker REMOVE their own request
-- ============================================================================
-- Once a seeker has been helped (or changed their mind) they should be able to
-- take their request down so agents stop calling. Two ownership models:
--
--   • SIGNED-IN seeker — the row carries their user_id; RLS already lets them
--     DELETE it directly. This RPC also covers that case (auth.uid() match).
--   • ANONYMOUS seeker — the row has user_id = null, so RLS blocks a direct
--     delete (there is no identity to check). The id is random and only lives
--     in the creator's own localStorage, and the PHONE is the secret the
--     privacy model already treats as un-browsable. So we delete an anon pin
--     only when BOTH the id AND the phone (digits only) match — proof of
--     ownership without exposing anything.
--
-- SECURITY DEFINER so the anon branch can delete a row the caller can't see,
-- but the WHERE clause makes it impossible to remove a row you can't prove you
-- own. Returns the number of rows removed (0 = nothing matched).
--
-- Idempotent. Safe to re-run. Depends on supabase/setup_house_demand.sql.
-- Paste into the Supabase SQL editor and Run.
-- ============================================================================
begin;

create or replace function public.house_demand_remove(
  p_id    text,
  p_phone text default null
) returns int
language plpgsql security definer
set search_path = public as $$
declare
  removed int;
begin
  delete from public.house_demand_pins d
  where d.id = p_id
    and (
      -- owner of a signed-in pin. user_id is TEXT (Clerk migration) and the
      -- live RLS policies key off app_uid() — the JWT `sub`, which is set for
      -- both Supabase- and Clerk-issued sessions — so match that exactly.
      (d.user_id is not null and d.user_id = app_uid())
      -- or an anonymous pin proven by a matching phone (digits only)
      or (
        d.user_id is null
        and p_phone is not null
        and regexp_replace(coalesce(d.phone, ''), '\D', '', 'g')
            = regexp_replace(p_phone, '\D', '', 'g')
        and length(regexp_replace(p_phone, '\D', '', 'g')) >= 9
      )
    );
  get diagnostics removed = row_count;
  return removed;
end;
$$;

grant execute on function public.house_demand_remove(text, text)
  to anon, authenticated;

commit;

-- ============================================================================
-- Done. Verify:
--   select public.house_demand_remove('dp-xxxx', '0712345678');  -- → 1 if removed
-- ============================================================================
