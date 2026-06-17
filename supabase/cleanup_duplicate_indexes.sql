-- ============================================================================
-- Drop redundant duplicate indexes (identical column set to a sibling that
-- stays). Each dropped index is plain (non-unique, not constraint-backed), so
-- removing it only saves write overhead + disk — no behaviour change. The
-- unique / primary / partial indexes are all kept.
-- (auth.* and storage.* duplicates are Supabase-managed and left untouched.)
-- Idempotent. Run in the SQL editor or via scripts/run_sql.mjs.
-- ============================================================================

-- call_requests: THREE identical indexes on (status, requested_at) → keep one.
drop index if exists public.call_requests_status_idx;
drop index if exists public.idx_call_requests_status;
-- kept: idx_call_requests_status_time (status, requested_at)

-- cash_retargets: two pairs of identical indexes → keep the *_idx names.
drop index if exists public.idx_cash_retargets_status;   -- dup of cash_retargets_status_idx (retarget_status, created_at)
drop index if exists public.idx_cash_retargets_ticket;   -- dup of cash_retargets_ticket_idx (ticket_code)

-- meet_rooms: plain index on (code) duplicates the UNIQUE constraint index.
drop index if exists public.meet_rooms_code_idx;         -- kept: meet_rooms_code_key (unique)

-- shipments: idx_shipments_tenant_created is actually (tenant_id, tracking_code)
-- — identical to idx_shipments_tenant_tracking. Keep the correctly-named one.
drop index if exists public.idx_shipments_tenant_created;
