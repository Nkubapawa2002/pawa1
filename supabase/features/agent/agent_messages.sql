-- ============================================================================
-- agent_messages.sql — admin → agent direct messages (to their account)
-- ============================================================================
-- The admin can send any message to agents — to one agent individually, or to a
-- group (everyone who hasn't paid, everyone who's been deactivated, the current
-- selection). The message lands in the agent's account and shows on their
-- dashboard until they dismiss it.
--
-- Identity is the agent's auth user id as TEXT (same as houses/trucks/services
-- owner_user_id and agent_profiles.user_id), matched via public.app_uid().
-- Admins (public.is_admin()) can write to anyone and read everything.
--
-- Idempotent. Safe to re-run. Depends on app_uid() + is_admin() (already in the
-- schema). Paste into the Supabase SQL editor and Run.
-- ============================================================================
begin;

create table if not exists public.agent_messages (
  id          uuid primary key default gen_random_uuid(),
  to_user_id  text not null,                 -- the agent's auth user id
  body        text not null,
  kind        text,                          -- 'individual' | 'unpaid' | 'deactivated' | 'broadcast'
  created_by  text,                          -- admin email who sent it
  created_at  timestamptz not null default now(),
  read_at     timestamptz                    -- null = unread (still shown)
);

create index if not exists agent_messages_inbox_idx
  on public.agent_messages (to_user_id, read_at);

alter table public.agent_messages enable row level security;

drop policy if exists "agent_messages self read"   on public.agent_messages;
drop policy if exists "agent_messages self update" on public.agent_messages;
drop policy if exists "agent_messages admin all"   on public.agent_messages;

-- An agent reads only their OWN messages (admins read all).
create policy "agent_messages self read" on public.agent_messages
  for select using (to_user_id = (select public.app_uid()) or public.is_admin());

-- An agent may mark their own messages read (and nothing else).
create policy "agent_messages self update" on public.agent_messages
  for update using (to_user_id = (select public.app_uid()))
  with check (to_user_id = (select public.app_uid()));

-- The admin sends (and can manage) any message.
create policy "agent_messages admin all" on public.agent_messages
  for all using (public.is_admin()) with check (public.is_admin());

commit;

-- ============================================================================
-- Done. Admin inserts one row per recipient; the agent's dashboard reads its
-- unread rows (to_user_id = app_uid()) and marks them read on dismiss.
-- ============================================================================
