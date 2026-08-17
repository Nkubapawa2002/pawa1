-- ============================================================================
-- One-off: reactivate existing (legacy) providers with a 30-day trial.
--
-- After the services pivot turned on the 48-hour pay-or-pause grace, every
-- provider who registered more than 48h ago with no billing row got hidden.
-- This grants each existing identity (bus/cargo agent, house owner, truck owner,
-- service provider) a 'trial' until +30 days so they stay visible while you
-- transition. NEW sign-ups still face the 48h rule.
--
-- Identity keys mirror the admin tracker (_aaIdentity): uid:<owner_user_id>,
-- else ph:<last 9 phone digits>, else nm:<lowercased name>.
-- ON CONFLICT DO NOTHING preserves any billing row you already set (e.g. paid).
-- Safe to re-run.
-- ============================================================================
insert into public.agent_billing (agent_key, name, phone, status, active, paid_until, plan, note, updated_by)
select distinct on (k) k, nm, ph, 'trial', true, current_date + 30, 'legacy-trial',
       'Auto-trial on services pivot 2026-06-07', 'system'
from (
  select case when coalesce(a.phone,'') <> '' then 'ph:' || right(regexp_replace(a.phone,'\D','','g'), 9)
              else 'nm:' || lower(trim(coalesce(a.name,'unknown'))) end as k,
         a.name as nm, a.phone as ph
  from public.agents a
  union all
  select case when h.owner_user_id is not null then 'uid:' || h.owner_user_id::text
              when coalesce(h.agent->>'phone','') <> '' then 'ph:' || right(regexp_replace(h.agent->>'phone','\D','','g'), 9)
              else 'nm:' || lower(trim(coalesce(h.agent->>'name','unknown'))) end,
         h.agent->>'name', h.agent->>'phone'
  from public.houses h
  union all
  select case when t.owner_user_id is not null then 'uid:' || t.owner_user_id::text
              when coalesce(t.owner->>'phone','') <> '' then 'ph:' || right(regexp_replace(t.owner->>'phone','\D','','g'), 9)
              else 'nm:' || lower(trim(coalesce(t.owner->>'name','unknown'))) end,
         t.owner->>'name', t.owner->>'phone'
  from public.trucks t
  union all
  select case when s.owner_user_id is not null then 'uid:' || s.owner_user_id::text
              when coalesce(s.owner->>'phone','') <> '' then 'ph:' || right(regexp_replace(s.owner->>'phone','\D','','g'), 9)
              else 'nm:' || lower(trim(coalesce(s.owner->>'name','unknown'))) end,
         s.owner->>'name', s.owner->>'phone'
  from public.services s
) src
where k is not null and k <> '' and k <> 'nm:unknown'
order by k
on conflict (agent_key) do nothing;
