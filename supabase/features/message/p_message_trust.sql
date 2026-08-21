-- ============================================================================
-- p_message_trust.sql — make the safety number mean something.
-- ============================================================================
-- THE BUG THIS FIXES
--
-- pm_peer() returned pm_keys.fingerprint: a text column, stored by the server,
-- handed to the client, and printed in the Verify dialog as "their safety
-- number". Two people would then read it to each other and conclude they were
-- talking privately.
--
-- They had concluded nothing. The safety number exists to catch exactly one
-- attacker: whoever can substitute a public key in this table. That attacker
-- can write the fingerprint column too. They hand you their own public_key
-- next to the real key's fingerprint, the numbers match on both phones, and
-- everything after that is read in the clear by the person in the middle.
--
-- A number the attacker supplies cannot police the attacker. So the client now
-- DERIVES the number from the public key it actually received, and for that it
-- needs the key itself — which pm_peer did not return. That is the whole
-- change here.
--
-- pm_keys.fingerprint stays, because dropping a column is a migration nobody
-- needs and it is still useful as a cheap tamper signal: if the stored number
-- disagrees with the derived one, something wrote to that row. It is reported,
-- never trusted, and nothing is decided by it.
--
-- WHAT THIS FILE DOES NOT DO
--
-- Pinning — remembering a key and shouting when it changes — is deliberately
-- client-side, in js/lib/pm-trust.js. A record of "what key did I see" that
-- lives on the server is a record the server can edit, which puts it in the
-- hands of the one party it is supposed to protect against. It belongs on the
-- device or nowhere.
--
--   usage:  node scripts/db/apply_sql.mjs supabase/features/message/p_message_trust.sql
-- ============================================================================

-- The return type changes, so the old one has to go first: Postgres will not
-- replace a function with a different OUT signature.
drop function if exists public.pm_peer(text);

create or replace function public.pm_peer(p_user_id text)
  returns table (
    user_id      text,
    display_name text,
    public_key   text,   -- the number is derived from THIS, on the device
    fingerprint  text,   -- what the server thinks it is; a tamper signal only
    is_agent     boolean,
    is_guest     boolean,
    region       text
  )
  language sql
  stable
  security definer
  set search_path = public
as $$
  select k.user_id, coalesce(k.display_name, ap.name), k.public_key, k.fingerprint,
         k.is_agent, k.is_guest, coalesce(k.region, ap.region)
  from public.pm_keys k
  left join public.agent_profiles ap on ap.user_id = k.user_id
  where k.user_id = p_user_id
    and exists (
      select 1
      from public.pm_members mine
      join public.pm_members theirs on theirs.thread_id = mine.thread_id
      where mine.user_id = public.app_uid() and theirs.user_id = p_user_id
    );
$$;

grant execute on function public.pm_peer(text) to anon, authenticated;

-- Handing out a public key is not a disclosure: pm_keys is world-readable by
-- design, because a public key is public and no phone or email lives in it.
-- The membership test above is about not serving a bulk roster, and it is
-- unchanged.
