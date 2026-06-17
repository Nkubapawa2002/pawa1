-- ============================================================================
-- SECURITY FIX: views must not bypass RLS (2026-06-10)
--
-- Both views were created without security_invoker, so they executed with the
-- view owner's privileges and IGNORED row-level security on the underlying
-- tables. payments_overview also had a SELECT grant to anon, which exposed
-- customer names, phone numbers and payment amounts to anyone holding the
-- public anon key. No frontend code reads payments_overview at all, and
-- tenant_secret_status is only read by authenticated tenant members (whose
-- RLS policy on tenant_settings still grants them their own row), so this
-- change breaks nothing.
-- ============================================================================

alter view public.payments_overview set (security_invoker = true);
alter view public.tenant_secret_status set (security_invoker = true);

revoke select on public.payments_overview from anon;
