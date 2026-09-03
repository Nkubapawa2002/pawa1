-- ============================================================================
--  agent_notices.sql — the admin's side of the conversation, delivered.
-- ============================================================================
--  agent_messages.sql gave the admin a way to write to an agent's account, and
--  it worked: the row lands, the dashboard draws it, the nav shows a count. But
--  everything the ADMIN does to an agent went unannounced, and those are the
--  things an agent most needs to hear:
--
--    · approved, so their listings stop being on a seven-day clock;
--    · deactivated, so their listings have just left the board;
--    · a payment recorded, and what it bought;
--    · a subscription with days left on it, which is the one that arrives too
--      late to be useful if it arrives when it has already lapsed.
--
--  All four were visible ONLY inside a banner on a dashboard the agent had to
--  open. An agent who is out working does not open a dashboard; they glance at
--  a phone. So this file makes them notices, and js/core/notify.js puts them in
--  the bell that rides on every page.
--
--  WHAT IS ADDED
--
--    three columns   title, severity, dedupe_key on agent_messages. Existing
--                    rows and the admin's own compose box keep working: all
--                    three are nullable or defaulted.
--    a trigger       every change an admin makes in the tracker writes the
--                    agent a plain sentence about it. In the DATABASE, not in
--                    the panel, because a notice the UI is responsible for
--                    sending is a notice somebody eventually forgets to send.
--    a reminder      agent_notices_remind(days) writes to everybody whose
--                    cover runs out inside that many days.
--    one read        my_notices() hands the bell the unread notices AND the
--                    subscription state in a single round trip.
--
--  WHY DEDUPE_KEY EXISTS. An automatic notice must be able to run twice and
--  say one thing. The reminder is keyed by the date it is reminding about, so
--  running it every morning for a week writes one row, not seven, and a second
--  admin pressing the button changes nothing. A partial unique index does the
--  work; nothing has to remember what it already said.
--
--  WHAT THIS IS NOT. It is not a second messaging system. P-Message is the
--  encrypted one, between people. This is the platform telling an account
--  something about itself: billing, approval, and a message from the admin. It
--  is one table, readable only by its recipient, and it carries no keys.
--
--  Idempotent. Safe to re-run. Depends on agent_messages.sql,
--  agent_billing_setup.sql, app_uid(), is_admin().
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. What a notice carries
-- ---------------------------------------------------------------------------
-- A title, because the bell has one line to make somebody tap. The body is
-- what they read when they do, and it stays optional to a reader in a hurry.
alter table public.agent_messages add column if not exists title      text;
alter table public.agent_messages add column if not exists severity   text;
alter table public.agent_messages add column if not exists dedupe_key text;

-- Severity is the difference between "your payment is recorded" and "your
-- listings are off the board", and the bell colours them differently. Written
-- as a constraint rather than a convention so a typo cannot invent a fourth.
alter table public.agent_messages drop constraint if exists agent_messages_severity_check;
alter table public.agent_messages add  constraint agent_messages_severity_check
  check (severity is null or severity in ('info', 'warn', 'urgent'));

-- Say a thing once. Partial, because a message the admin typed has no key and
-- there is no reason two of those should ever collide.
create unique index if not exists agent_messages_dedupe_idx
  on public.agent_messages (to_user_id, dedupe_key)
  where dedupe_key is not null;

create index if not exists agent_messages_unread_idx
  on public.agent_messages (to_user_id, created_at desc)
  where read_at is null;

-- ---------------------------------------------------------------------------
-- 2. Writing one
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER, because the writer here is the DATABASE. The admin-only
-- insert policy on agent_messages is right for a person typing into a box, and
-- wrong for a trigger firing inside somebody else's transaction.
--
-- Returns the id, or null when the notice was a duplicate of one already sent.
-- Not an error: saying nothing the second time is the whole point of the key.
create or replace function public.agent_notice_send(
  p_uid      text,
  p_title    text,
  p_body     text,
  p_kind     text default 'notice',
  p_severity text default 'info',
  p_dedupe   text default null
) returns uuid
  language plpgsql
  security definer
  set search_path = public
as $fn$
declare
  v_id uuid;
begin
  if coalesce(p_uid, '') = '' or coalesce(p_title, '') = '' then
    return null;
  end if;

  insert into public.agent_messages (to_user_id, title, body, kind, severity, dedupe_key, created_by)
  values (p_uid, p_title, coalesce(p_body, ''), p_kind, coalesce(p_severity, 'info'), p_dedupe, 'system')
  on conflict do nothing
  returning id into v_id;

  return v_id;
end $fn$;

-- ---------------------------------------------------------------------------
-- 3. Everything the admin does in the tracker, said out loud
-- ---------------------------------------------------------------------------
-- agent_billing is keyed by agent_key: 'uid:<account>' for somebody who signed
-- up, 'ph:<number>' for a phone that appeared on a listing before there was an
-- account behind it. Only the first names an account that can be written to,
-- and the second is skipped rather than guessed at.
--
-- Five things are worth a sentence, and the order matters: a row that is both
-- deactivated and paid is deactivated, and that is what the agent needs to
-- read first.
create or replace function public.agent_billing_notice()
  returns trigger
  language plpgsql
  security definer
  set search_path = public
as $fn$
declare
  v_uid text;
  v_fee text;
begin
  if new.agent_key not like 'uid:%' then return new; end if;
  v_uid := substring(new.agent_key from 5);
  if coalesce(v_uid, '') = '' then return new; end if;

  -- Deactivated. The most serious thing that can happen to an agent here: not
  -- one listing, all of them, off the public board until an admin says
  -- otherwise. It says how to get back rather than only what happened.
  if new.active is false and (tg_op = 'INSERT' or old.active is distinct from false) then
    perform public.agent_notice_send(
      v_uid,
      'Your listings have been paused',
      coalesce(nullif(new.note, ''), 'An admin has deactivated this account, so your listings are not on the public board at the moment.') ||
        ' Contact the admin to sort it out.',
      'billing', 'urgent',
      'deactivated:' || to_char(now(), 'YYYY-MM-DD"T"HH24:MI'));
    return new;
  end if;

  -- Back on.
  if new.active is true and tg_op = 'UPDATE' and old.active is false then
    perform public.agent_notice_send(
      v_uid,
      'Your listings are live again',
      'An admin has reactivated this account. Everything you had listed is back on the board.',
      'billing', 'info',
      'reactivated:' || to_char(now(), 'YYYY-MM-DD"T"HH24:MI'));
  end if;

  -- Approved. This is the one that lifts the seven-day clock, and until now
  -- the only way to find out was to notice that nothing had disappeared.
  if new.approved_at is not null and (tg_op = 'INSERT' or old.approved_at is null)
     and coalesce(new.approved_by, '') <> 'grandfathered' then
    perform public.agent_notice_send(
      v_uid,
      'Your account is approved',
      'An admin has approved this account, so your listings stay on the board. From here it is the monthly subscription that keeps them there.',
      'billing', 'info',
      'approved:' || to_char(new.approved_at, 'YYYY-MM-DD'));
  end if;

  -- A payment recorded, and what it bought. The DATE is the useful half: an
  -- agent who knows when their cover ends can plan the next payment, and one
  -- who is only told "thank you" cannot.
  if new.paid_until is not null
     and (tg_op = 'INSERT' or old.paid_until is null or new.paid_until > old.paid_until) then
    v_fee := case when new.amount_tzs > 0
                  then ' (TZS ' || to_char(new.amount_tzs, 'FM999,999,999') || ')'
                  else '' end;
    perform public.agent_notice_send(
      v_uid,
      'Payment recorded' || v_fee,
      'Your subscription now runs to ' || to_char(new.paid_until, 'FMDD Mon YYYY') ||
        '. You will get a reminder here before it ends.',
      'billing', 'info',
      'paid:' || to_char(new.paid_until, 'YYYY-MM-DD'));
  end if;

  -- Marked overdue or cancelled by hand.
  if tg_op = 'UPDATE' and new.status is distinct from old.status
     and new.status in ('overdue', 'cancelled') then
    perform public.agent_notice_send(
      v_uid,
      case new.status when 'overdue' then 'Your subscription is overdue'
                      else 'Your subscription has been cancelled' end,
      'Your listings stay hidden until this is settled. Pay the admin and they will put your account back on.',
      'billing', 'urgent',
      new.status || ':' || to_char(now(), 'YYYY-MM-DD'));
  end if;

  return new;
end $fn$;

drop trigger if exists agent_billing_notice on public.agent_billing;
create trigger agent_billing_notice
  after insert or update on public.agent_billing
  for each row execute function public.agent_billing_notice();

-- ---------------------------------------------------------------------------
-- 4. "Your cover runs out on Friday"
-- ---------------------------------------------------------------------------
-- The one notice that has to be sent BEFORE the thing happens, which is why it
-- cannot be a trigger: nothing changes on the day a subscription starts running
-- out. It is a sweep, and it is safe to run every morning: the dedupe key is
-- the date being warned about, so a week of runs writes one row per agent.
--
-- Admins call it from the panel. A scheduled job can call it with the service
-- key, which is how it should eventually run: n8n already carries this
-- project's cron.
create or replace function public.agent_notices_remind(p_days int default 7)
  returns int
  language plpgsql
  security definer
  set search_path = public
as $fn$
declare
  v_days int := greatest(1, least(coalesce(p_days, 7), 60));
  v_n    int := 0;
  r      record;
  v_id   uuid;
  -- Parsed defensively: the setting is absent for a database-internal caller
  -- and can be an empty string, and neither must raise inside a sweep.
  v_role text := (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role');
begin
  -- Who may run a sweep: an admin, or the SERVER itself.
  --
  -- The second half is what lets this be scheduled. It is read from the JWT
  -- ROLE CLAIM and not from current_user, and that distinction is the whole
  -- correctness of this check: inside a SECURITY DEFINER function current_user
  -- is the function's OWNER, so testing it would return 'postgres' for every
  -- caller alive and let any signed-in agent write to eighty accounts.
  --
  -- No claim at all means the caller is the database itself: pg_cron (which is
  -- how this runs every morning, see agent_notices_cron.sql), a migration, or
  -- the SQL editor. 'service_role' is a key held only by servers. Neither is an
  -- end user and both already have the run of this database.
  --
  -- What stays refused is the case that matters: an `authenticated` or `anon`
  -- session that is not an admin.
  if not (public.is_admin() or v_role is null or v_role = 'service_role') then
    raise exception 'Admins only';
  end if;

  for r in
    select b.agent_key,
           substring(b.agent_key from 5) as uid,
           b.paid_until,
           (b.paid_until - current_date) as days_left
      from public.agent_billing b
     where b.agent_key like 'uid:%'
       and b.active is not false
       and b.status not in ('cancelled')
       and b.paid_until is not null
       and b.paid_until >= current_date
       and b.paid_until <= current_date + v_days
  loop
    v_id := public.agent_notice_send(
      r.uid,
      case when r.days_left = 0 then 'Your subscription ends today'
           when r.days_left = 1 then 'Your subscription ends tomorrow'
           else 'Your subscription ends in ' || r.days_left || ' days' end,
      'It runs to ' || to_char(r.paid_until, 'FMDD Mon YYYY') ||
        '. Pay the admin before then and they will extend it. If it lapses your listings come off the public board until it is settled.',
      'billing',
      case when r.days_left <= 2 then 'urgent' else 'warn' end,
      'renew:' || to_char(r.paid_until, 'YYYY-MM-DD'));
    if v_id is not null then v_n := v_n + 1; end if;
  end loop;

  return v_n;
end $fn$;

-- ---------------------------------------------------------------------------
-- 5. One read for the bell
-- ---------------------------------------------------------------------------
-- The bell is on every page of the app and refreshes on a two-minute beat, so
-- what it costs matters. This is one call: the unread notices, and the state of
-- the subscription they are usually about.
--
-- days_left is computed HERE rather than in the browser. A phone with the wrong
-- date would otherwise tell somebody their cover ends next week when it ended
-- yesterday, and the one number this whole feature exists to get right would be
-- the one number nobody could trust.
create or replace function public.my_notices()
  returns jsonb
  language plpgsql
  stable
  security definer
  set search_path = public
as $fn$
declare
  v_uid    text := public.app_uid();
  v_rows   jsonb;
  v_n      int;
  v_sub    record;
  v_left   int;
begin
  if v_uid is null then
    return jsonb_build_object('unread', 0, 'notices', '[]'::jsonb, 'billing', null);
  end if;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]'::jsonb), count(*)::int
    into v_rows, v_n
  from (
    select m.id, m.title, m.body, m.kind, coalesce(m.severity, 'info') as severity, m.created_at
      from public.agent_messages m
     where m.to_user_id = v_uid and m.read_at is null
     order by m.created_at desc
     limit 20
  ) x;

  -- The live state, so an agent sees "6 days left" even when no row has been
  -- written yet. The reminder sweep and this read agree because they read the
  -- same column; neither is the other's cache.
  select * into v_sub from public.my_agent_subscription() limit 1;
  if v_sub.paid_until is not null then
    v_left := v_sub.paid_until - current_date;
  end if;

  return jsonb_build_object(
    'unread',  coalesce(v_n, 0),
    'notices', coalesce(v_rows, '[]'::jsonb),
    'billing', case when v_sub.reason is null or v_sub.reason = 'none' then null
      else jsonb_build_object(
        'reason',     v_sub.reason,
        'active',     v_sub.active,
        'status',     v_sub.status,
        'paid_until', v_sub.paid_until,
        'days_left',  v_left,
        'deadline',   v_sub.deadline)
    end);
end $fn$;

-- Marking one read, from anywhere. The client could update the row directly --
-- the self-update policy allows it -- but every caller then has to remember to
-- write a timestamp and to scope the update to itself, and one of them will
-- not. Returns true when a row was actually marked.
create or replace function public.notice_mark_read(p_id uuid)
  returns boolean
  language plpgsql
  security definer
  set search_path = public
as $fn$
declare
  v_uid text := public.app_uid();
  v_n   int;
begin
  if v_uid is null then return false; end if;
  update public.agent_messages
     set read_at = now()
   where id = p_id and to_user_id = v_uid and read_at is null;
  get diagnostics v_n = row_count;
  return v_n > 0;
end $fn$;

create or replace function public.notices_mark_all_read()
  returns int
  language plpgsql
  security definer
  set search_path = public
as $fn$
declare
  v_uid text := public.app_uid();
  v_n   int;
begin
  if v_uid is null then return 0; end if;
  update public.agent_messages
     set read_at = now()
   where to_user_id = v_uid and read_at is null;
  get diagnostics v_n = row_count;
  return v_n;
end $fn$;

-- ---------------------------------------------------------------------------
-- 6. Grants
-- ---------------------------------------------------------------------------
-- agent_notice_send is NOT granted to anybody. It is the database's own writer,
-- reached through the trigger and the sweep, and a client that could call it
-- could write a message to any account and sign it 'system'.
revoke all on function public.agent_notice_send(text, text, text, text, text, text) from public, anon, authenticated;

grant execute on function public.my_notices()                to anon, authenticated;
grant execute on function public.notice_mark_read(uuid)      to anon, authenticated;
grant execute on function public.notices_mark_all_read()     to anon, authenticated;
grant execute on function public.agent_notices_remind(int)   to authenticated;

commit;
