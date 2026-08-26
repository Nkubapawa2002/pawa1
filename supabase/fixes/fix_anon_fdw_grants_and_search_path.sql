-- ============================================================================
-- Two findings from spidering the production database, 2026-08-26.
--
-- APPLIED to production on 2026-08-26. Idempotent: safe to re-run.
--
-- Verified after applying:
--   functions in public with no search_path pin ....  0   (want 0)
--   "ID" grants to anon / authenticated ............  0   (was 14, seven each)
--   crypto fns pinned WITH extensions ..............  4   (want 4)
--   "ID" grants to postgres / service_role .........  14  (untouched)
--
-- And at runtime, because the pin is the half that breaks silently — a
-- function that has lost pgcrypto does not fail until something encrypts:
--   tenant_encrypt -> tenant_decrypt round-trips to the original plaintext
--   loc_feistel25(123456, '\x0102030405')            -> 4526484
--   generate_tracking_code('Dar es Salaam','Arusha') -> TZ-DAR-ARU-XGR0BC-JSVQ-6
--
--
-- 1. THE CLERK FOREIGN TABLE THAT anon COULD ADDRESS
--
-- `public."ID"` is not a table anybody wrote rows into. It is a FOREIGN table
-- over the Clerk Admin API — server "maisha na lifeza_server", wrapper
-- supabase:clerk-fdw 0.1.0, api_url discrete-prawn-57.clerk.accounts.dev,
-- remote object `domains` — and it authenticates with a Clerk API key the
-- wrapper reads out of the `vault` schema at query time.
--
-- anon and authenticated held SELECT, INSERT, UPDATE, DELETE and TRUNCATE on
-- it. A foreign table cannot carry row-level security, so RLS was never in
-- the path: the grant WAS the whole fence. PostgREST exposes it, and the
-- publishable key in js/core/config.js is enough to address it.
--
-- It is not exploitable as it stands, and that is worth saying precisely
-- because it is the reason this is a hardening fix and not an incident:
--
--     GET /rest/v1/ID  ->  401  {"code":"42501",
--                                "message":"permission denied for schema vault"}
--
-- The request passes the table grant and dies one step later, when the
-- wrapper tries to read the API key as anon. The database is protected by
-- anon's lack of vault access, not by anything anyone decided about this
-- table. Grant vault access for some unrelated reason later, or point a
-- second foreign table at `users` instead of `domains`, and the fence is
-- gone. So: take the grant away, and let the fence be the thing that was
-- meant to be the fence.
--
-- CAVEAT ON THAT 401, ADDED AFTER REVIEW: it was observed ONCE, from one
-- machine. A second session could not reproduce it — the same request hung
-- and timed out instead (api.supabase.com connect-times-out from here on
-- roughly half of all calls). So treat "it fails closed at the vault" as a
-- single observation, not an established property. It does not change the
-- fix: the grant was unnecessary either way, and a fence that depends on an
-- unrelated permission is not a fence whether or not it happens to hold.

-- Nothing in the app reads this table. Clerk is driven from
-- js/core/auth-clerk.js against Clerk's FRONTEND api, gated behind
-- APP_CONFIG.USE_CLERK, and never through this wrapper.
--
-- If this table is what it looks like — an experiment left behind from wiring
-- the Clerk wrapper up — the better end state is dropping it and the FDW
-- server with it. That is a decision, not a fix, so it is not in this file.

revoke all on table public."ID" from anon, authenticated;


-- 2. 28 FUNCTIONS WITH A ROLE-MUTABLE search_path
--
-- All 28 are SECURITY INVOKER (supabase/fixes/fix_function_search_path.sql
-- already pinned the three SECURITY DEFINER ones). So this is hardening, not
-- an open door: a mutable search_path resolves through `"$user"`, a schema an
-- attacker able to create one can control.
--
-- THE PIN IS NOT `''`, AND THAT IS DELIBERATE.
-- pgcrypto lives in the `extensions` schema in this project, and four of these
-- functions call it UNQUALIFIED:
--
--     generate_tracking_code   loc_feistel25   tenant_encrypt   tenant_decrypt
--
-- Pinning those to `''` — or to `pg_catalog, public`, which is what the
-- linter's own example does — breaks tracking-code minting and tenant
-- encryption at runtime, silently, until something tries to encrypt. They get
-- `extensions` and the other 24 do not.
--
-- The effective search_path today is `"$user", public, extensions`. Both pins
-- below are that set minus the injectable `"$user"` element, so nothing that
-- resolves today stops resolving.
--
-- The loop is here rather than 28 written-out signatures so that re-running it
-- after somebody adds a function picks that one up too, and so no signature
-- can be mistyped.

do $$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure::text as sig,
           p.prosrc
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind = 'f'
       and (p.proconfig is null
            or not exists (select 1 from unnest(p.proconfig) c
                            where c like 'search_path=%'))
  loop
    if fn.prosrc ~* '(pgp_sym|gen_random|digest|hmac|crypt\(|uuid_generate)' then
      execute format(
        'alter function %s set search_path = pg_catalog, public, extensions', fn.sig);
    else
      execute format(
        'alter function %s set search_path = pg_catalog, public', fn.sig);
    end if;
  end loop;
end $$;


-- VERIFY (expects 0 rows)
--
--   select p.proname
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.prokind = 'f'
--      and (p.proconfig is null
--           or not exists (select 1 from unnest(p.proconfig) c
--                           where c like 'search_path=%'));
--
--   select grantee, privilege_type from information_schema.role_table_grants
--    where table_schema = 'public' and table_name = 'ID'
--      and grantee in ('anon','authenticated');
--
--
-- WHAT IS DELIBERATELY NOT IN THIS FILE
--
-- * The 7 `rls_enabled_no_policy` tables — pm_presence, loc_shares,
--   loc_share_secrets, loc_share_tickets, loc_share_misses, day_job_owners,
--   day_job_owner_tokens. RLS on with no policy is deny-all, and deny-all is
--   the DESIGN: they are reached through SECURITY DEFINER RPCs, never from a
--   client. js/lib/pm-presence.js:32 says so in as many words. Anyone "fixing"
--   this advisory by adding a policy is opening a door, not closing one.
--
-- * The 200 `*_security_definer_function_executable` advisories. That is the
--   RPC layer being reachable by the roles it exists to serve. Revoking those
--   would take the app off the air.
--
-- * The 43 `auth_allow_anonymous_sign_ins` advisories. Guests are a product
--   decision; app_is_guest() is the fence.
--
-- * `extension_in_public` (pg_net). Moving it breaks the n8n webhook path for
--   no security gain worth that.
--
-- * `auth_leaked_password_protection`. A dashboard toggle
--   (Authentication -> Policies), not SQL.
-- ============================================================================
