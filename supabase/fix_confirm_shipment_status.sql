-- ============================================================================
-- Tighten confirm_shipment_status (public tracking-chat "Arrived/Delivered").
--
-- The tracking code is the only credential the caller presents, so this RPC now
-- only permits FORWARD confirmation once a parcel is actually moving/arrived. It
-- refuses to touch pre-dispatch shipments (Awaiting Price / Needs Revision /
-- Registered / Collected) or to un-deliver a completed one — closing a code-
-- guessing tamper path. Authoritative copy lives in supabase/agent_auth.sql.
--
-- Idempotent. Safe to re-run. Run in the SQL editor or via scripts/run_sql.mjs.
-- ============================================================================
create or replace function public.confirm_shipment_status(p_code text, p_status text)
returns void language plpgsql security definer set search_path = public as $fn$
declare v_cur text;
begin
  if p_status not in ('Arrived', 'Delivered') then
    raise exception 'confirm_shipment_status only allows Arrived or Delivered (got %)', p_status;
  end if;
  select status into v_cur from public.shipments where tracking_code = p_code;
  if not found then
    raise exception 'shipment % not found', p_code;
  end if;
  if p_status = 'Arrived'   and v_cur not in ('Picked Up', 'In Transit', 'Arrived') then
    raise exception 'cannot mark Arrived from status %', v_cur;
  end if;
  if p_status = 'Delivered' and v_cur not in ('In Transit', 'Arrived', 'Delivered') then
    raise exception 'cannot mark Delivered from status %', v_cur;
  end if;
  update public.shipments
     set status = p_status, updated_at = now()
   where tracking_code = p_code;
end;
$fn$;

grant execute on function public.confirm_shipment_status(text, text) to anon, authenticated;
