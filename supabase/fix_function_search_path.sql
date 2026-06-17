-- ============================================================================
-- Harden SECURITY DEFINER functions that had a mutable search_path.
--
-- A definer function without a pinned search_path can be hijacked by a caller
-- who puts a malicious object earlier in their search_path (Supabase's linter
-- flags this as "function_search_path_mutable"). All three below fully-qualify
-- their cross-schema calls (public.* / realtime.*), so pinning search_path to
-- public is safe and changes no behaviour.
-- Idempotent. Run in the SQL editor or via scripts/run_sql.mjs.
-- ============================================================================
alter function public.driver_heartbeat(
  text, text, text, text, text, text, double precision, double precision, double precision, text
) set search_path = public;

alter function public.payments_overview_broadcast_trigger()  set search_path = public;
alter function public.realtime_broadcast_any_table_changes() set search_path = public;
