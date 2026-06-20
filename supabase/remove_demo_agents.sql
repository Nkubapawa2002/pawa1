-- ============================================================================
-- remove_demo_agents.sql — clear the bus-era DEMO agent directory.
-- ============================================================================
-- The `agents` table (19 rows: "Juma Hassan", "Grace Kileo"… with bus routes)
-- plus their applications, reviews and phone-keyed (ph:…) billing are seed/demo
-- data from the pre-pivot bus app. The CURRENT agent system lives in
-- agent_profiles (real accounts) + listings.owner_user_id, which are untouched.
--
-- Real billing is uid-keyed (agent_key like 'uid:%') and is KEPT; only the demo
-- phone-keyed bus billing is removed. Backed up to backup_demo_agents_2026-06-20.json.
--
-- Idempotent. Paste into the Supabase SQL editor and Run.
-- ============================================================================
begin;

delete from public.agent_reviews;                                  -- bus-era reviews (FK → agents)
delete from public.agent_applications;                             -- bus-era applications
delete from public.agents;                                        -- the demo bus directory
delete from public.agent_billing where agent_key not like 'uid:%'; -- demo (ph:…) billing only

commit;

-- ============================================================================
-- Verify: agents/agent_applications/agent_reviews empty; agent_billing holds
-- only real uid-keyed rows; agent_profiles (real agents) untouched.
-- ============================================================================
