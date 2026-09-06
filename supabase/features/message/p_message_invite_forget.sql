-- ============================================================================
-- p_message_invite_forget.sql — an agent can take a dead link off their list.
-- ============================================================================
-- pm_invites_mine() returns every invite an agent ever made, forever. There is
-- no way to remove one, so the list is a graveyard: a link withdrawn in March
-- sits above the two that are actually live in September, and an agent
-- scanning for "who is still waiting on me" reads four rows to find one.
--
-- Worse, the row that stays is the one the agent asked us to destroy. Somebody
-- who sends a link to the wrong number, panics, and withdraws it is told the
-- link is dead and then shown it on every visit. That is the app disagreeing
-- with itself about whether the thing is gone.
--
-- So: two deletes, both scoped to the caller's own invites by app_uid(), both
-- refusing to touch a link that is still live.
--
--   pm_invite_forget(hash)      one row, and only a FINISHED one
--   pm_invites_clear_finished() every finished row, returns how many went
--
-- WHY A FINISHED LINK ONLY
-- An open invite that vanishes from the list is an open invite: whoever holds
-- it can still walk into a thread, and the agent has just lost the one screen
-- that could have told them so. Removing it would be hiding a live credential,
-- which is the opposite of what the person asking is trying to do. Withdraw
-- first (pm_invite_revoke), then remove. The UI enforces the same order, but
-- the database is where it has to be true.
--
-- WHY THE ROW IS SAFE TO DESTROY
-- A used invite's thread does not depend on it. pm_invites.thread_id points at
-- pm_threads, not the other way round, so the conversation, its members and
-- every message outlive the invite that introduced them. Nothing else in the
-- schema references pm_invites at all.
--
-- Idempotent. Safe to re-run. Depends on p_message_invites.sql.
--
-- Apply with:  node scripts/db/apply_sql.mjs supabase/features/message/p_message_invite_forget.sql
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. One link
-- ---------------------------------------------------------------------------
-- Returns true when a row went, false when nothing matched. The caller needs
-- to tell "already gone" apart from "refused because it is still live", and a
-- void return can say neither.
create or replace function public.pm_invite_forget(p_token_hash text)
  returns boolean
  language plpgsql
  security definer
  set search_path = public
as $fn$
declare
  v_uid  text := public.app_uid();
  v_gone int;
begin
  if v_uid is null then raise exception 'Sign in first'; end if;

  delete from public.pm_invites
   where token_hash = p_token_hash
     and agent_id = v_uid
     -- Finished, by any of the three routes. An invite that is none of these
     -- is open, and an open link is not a list entry to tidy away.
     and (revoked_at is not null or accepted_at is not null or expires_at < now());

  get diagnostics v_gone = row_count;
  if v_gone = 0 and exists (
    select 1 from public.pm_invites
     where token_hash = p_token_hash and agent_id = v_uid
  ) then
    raise exception 'That link is still live. Withdraw it first.';
  end if;

  return v_gone > 0;
end $fn$;

-- ---------------------------------------------------------------------------
-- 2. All of them at once
-- ---------------------------------------------------------------------------
-- The same rule, applied to the whole list, because clearing eleven finished
-- links one tap at a time is eleven round trips and eleven chances to give up
-- halfway.
create or replace function public.pm_invites_clear_finished()
  returns integer
  language plpgsql
  security definer
  set search_path = public
as $fn$
declare
  v_uid  text := public.app_uid();
  v_gone int;
begin
  if v_uid is null then raise exception 'Sign in first'; end if;

  delete from public.pm_invites
   where agent_id = v_uid
     and (revoked_at is not null or accepted_at is not null or expires_at < now());

  get diagnostics v_gone = row_count;
  return v_gone;
end $fn$;

-- ---------------------------------------------------------------------------
-- 3. Grants
-- ---------------------------------------------------------------------------
-- Only an account has invites to remove, so only `authenticated` is granted.
--
-- The revoke of PUBLIC is here because Postgres grants EXECUTE to PUBLIC on
-- every new function and a bare `grant ... to authenticated` therefore narrows
-- nothing on its own.
--
-- It does not, however, get rid of `anon`: this project's default privileges
-- grant execute to `anon` on every function in `public`, so a re-grant lands
-- the moment the function is created and \df+ will show anon here, exactly as
-- it does for pm_invite_create and pm_invites_mine, which ask for the same
-- thing. The fence that actually holds is inside both functions: app_uid() is
-- null for a caller with no session and they raise before touching a row, and
-- every delete is scoped to that uid. That is the same fence the rest of
-- P-Message stands on, not a weaker one.
revoke execute on function public.pm_invite_forget(text)      from public;
revoke execute on function public.pm_invites_clear_finished() from public;
grant  execute on function public.pm_invite_forget(text)        to authenticated;
grant  execute on function public.pm_invites_clear_finished()   to authenticated;

commit;
