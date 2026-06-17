-- ============================================================================
-- agent_billing.started_on — anchor monthly subscriptions to the APPROVED day
-- ============================================================================
-- Every agent's monthly subscription is billed from the day they were approved
-- / first went live (their "anchor day"). The admin "All Agents" tab records
-- each month so that paid_until always lands on that same day-of-month, instead
-- of drifting with whenever the admin happens to click "+1 month".
--
--   started_on — the approval/anchor date. Defaults (backfilled below) to the
--                agent's earliest registration time, which is when they first
--                appeared on the platform = effectively their approved day.
--
-- Depends on: supabase/agent_billing.sql  (+ optionally agent_grace_active.sql
-- for agent_registered_at(), used only for the one-time backfill).
-- Run once in the Supabase SQL editor. Idempotent — safe to re-run.
-- ----------------------------------------------------------------------------

alter table public.agent_billing
  add column if not exists started_on date;

-- One-time backfill: anchor existing billing rows to each agent's earliest
-- registration. Guarded so it runs only if agent_registered_at() is present
-- (i.e. agent_grace_active.sql has been applied); otherwise skipped silently.
do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'agent_registered_at'
  ) then
    update public.agent_billing b
       set started_on = coalesce(
             public.agent_registered_at(b.agent_key)::date,
             b.created_at::date)
     where b.started_on is null;
  else
    update public.agent_billing
       set started_on = created_at::date
     where started_on is null;
  end if;
end $$;

-- Next monthly cycle date, anchored to `p_anchor`'s day-of-month, that falls
-- strictly after `p_after`. Day-of-month is clamped for short months (e.g. an
-- anchor on the 31st becomes the 30th/28th where needed). Exposed so the admin
-- panel and any future cron can agree on the exact same renewal arithmetic.
create or replace function public.agent_next_due(p_anchor date, p_after date)
returns date language plpgsql stable as $fn$
declare
  v_day  int;
  v_due  date;
  v_base date := coalesce(p_after, current_date);
begin
  if p_anchor is null then
    return (v_base + interval '1 month')::date;   -- no anchor → plain +1 month
  end if;
  v_day := extract(day from p_anchor)::int;
  -- Start one month past the base, then snap to the anchor day-of-month.
  v_due := date_trunc('month', v_base + interval '1 month')::date;
  v_due := v_due
         + (least(v_day, extract(day from (date_trunc('month', v_due)
                                           + interval '1 month - 1 day'))::int) - 1);
  return v_due;
end;
$fn$;
