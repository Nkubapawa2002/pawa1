-- Security hardening for the finance / accounting portal.
--
-- Audit found these tables were reachable WITHOUT login:
--   * org_adjustments    — RLS policy "adj_all"        FOR ALL TO public USING true
--   * ledger_adjustments — RLS policy "ledger_adj all" FOR ALL TO public USING true
--   * book_adjustments   — RLS policy "book_adj all"   FOR ALL TO public USING true
--     → anyone (even anonymous) could READ, INSERT, UPDATE and DELETE the
--       accounting ledger. These tables are used only by the login-gated
--       accounting portal (js/accounting.js), so they must require a signed-in
--       finance user.
--   * payments — SELECT policy "anon_select_payments" TO anon,authenticated
--       USING true → anyone could read EVERY payment row (amounts, refs).
--       The public checkout legitimately needs to poll ONE payment's status,
--       so we replace the blanket read with a SECURITY DEFINER RPC that returns
--       a single row by id, and restrict table SELECT to finance users.
--
-- is_finance_user() = email present in admins with role admin/accountant/auditor.
-- Idempotent. Safe to re-run.

-- ---------------------------------------------------------------------------
-- 1. Accounting adjustment tables → signed-in finance users only
-- ---------------------------------------------------------------------------
drop policy if exists "adj_all"        on public.org_adjustments;
drop policy if exists "org_adj finance" on public.org_adjustments;
create policy "org_adj finance" on public.org_adjustments for all to authenticated
  using (is_finance_user()) with check (is_finance_user());

drop policy if exists "ledger_adj all"     on public.ledger_adjustments;
drop policy if exists "ledger_adj finance" on public.ledger_adjustments;
create policy "ledger_adj finance" on public.ledger_adjustments for all to authenticated
  using (is_finance_user()) with check (is_finance_user());

drop policy if exists "book_adj all"     on public.book_adjustments;
drop policy if exists "book_adj finance" on public.book_adjustments;
create policy "book_adj finance" on public.book_adjustments for all to authenticated
  using (is_finance_user()) with check (is_finance_user());

-- ---------------------------------------------------------------------------
-- 2. payments — stop the world-readable leak, keep checkout status-polling
-- ---------------------------------------------------------------------------
-- Public checkout polls its own payment by id through this function (it can
-- only see the row whose id it already holds — no enumeration of others).
create or replace function public.payment_status(p_id uuid)
returns table (
  id            uuid,
  status        text,
  provider      text,
  provider_ref  text,
  external_ref  text,
  amount_tzs    numeric,
  reference     text,
  paid_at       timestamptz,
  error_message text,
  payment_url   text
)
language sql stable security definer
set search_path = public as $$
  select id, status, provider, provider_ref, external_ref,
         amount_tzs, reference, paid_at, error_message, payment_url
  from public.payments
  where id = p_id;
$$;
grant execute on function public.payment_status(uuid) to anon, authenticated;

-- Replace the blanket anon read with a finance-only read of the full table.
-- (INSERT by the checkout flow + admin/service UPDATE policies are unchanged.)
drop policy if exists "anon_select_payments"    on public.payments;
drop policy if exists "finance_select_payments" on public.payments;
create policy "finance_select_payments" on public.payments for select to authenticated
  using (is_finance_user());
