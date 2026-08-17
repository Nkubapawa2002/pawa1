-- =====================================================================
-- clerk_migrate_owner_ids.sql
-- One-time data migration: re-point existing rows from the Supabase-Auth user
-- UUID to the matching Clerk user id (matched by email, done out-of-band).
--
-- Only ONE real user existed at cutover (pawa4761@gmail.com, the owner/admin):
--   Supabase auth.users.id : 658d380e-21dd-47fd-aa21-9afa1d3465f3
--   Clerk user id          : user_3FAMy8GfVOeFV72J7pbiu1MTBjf
--
-- Only the text owner columns are remapped (those converted in
-- clerk_text_user_ids.sql). tenants.owner_user_id / tenant_users.user_id stay
-- uuid — the owner keeps access to those via is_super_admin() (email-based), and
-- those are legacy bus-SaaS tables. Idempotent (re-running is a no-op once done).
-- =====================================================================
begin;

do $$
declare
  v_old text := '658d380e-21dd-47fd-aa21-9afa1d3465f3';
  v_new text := 'user_3FAMy8GfVOeFV72J7pbiu1MTBjf';
begin
  update public.houses            set owner_user_id = v_new where owner_user_id = v_old;
  update public.trucks            set owner_user_id = v_new where owner_user_id = v_old;
  update public.services          set owner_user_id = v_new where owner_user_id = v_old;
  update public.house_tenancies   set owner_user_id = v_new where owner_user_id = v_old;
  update public.house_demand_pins set user_id       = v_new where user_id       = v_old;
  update public.agents            set user_id       = v_new where user_id       = v_old;
  -- Subscription/billing is keyed "uid:<id>" — keep the owner's history.
  update public.agent_billing     set agent_key = 'uid:' || v_new where agent_key = 'uid:' || v_old;
end $$;

commit;
