# Notices, and the console that sends them

Two things were true of this app at the same time, and they do not go together:

- an admin could **deactivate an account**, approve one, record a payment or
  cancel a subscription, and the agent found out by noticing that their
  listings had disappeared;
- and an agent's subscription could lapse on a Friday with **no warning
  anywhere**, because the only surface that said anything about billing was a
  banner on a dashboard that somebody out working never opens.

`agent_messages.sql` had given the admin a way to write to an account, and it
worked. What was missing was everything the admin *did*, and everything that
was about to happen.

---

## The shape of it

```
   admin acts in the tracker            time passes
   (approve / pay / pause / cancel)     (a subscription runs down)
            │                                     │
            ▼                                     ▼
   trigger agent_billing_notice        agent_notices_remind(days)
            │                                     │
            └──────────► public.agent_messages ◄──┘
                                │
                    my_notices()│  one read: unread + billing state
                                ▼
              ┌─────────────────┴──────────────────┐
              ▼                                    ▼
        the bell (every page)              Profile ▸ From the admin
     js/core/notify.js + notify-ui         js/pages/profile.js
```

`supabase/features/agent/agent_notices.sql` and `agent_notices_cron.sql` —
**both APPLIED to production.** Proof: `node tests/agent_notices_test.mjs`
(30 assertions, RLS on, including that the schedule exists and that running it
exactly as pg_cron does reaches the agent), `node tests/notices_ui_test.mjs`
(15, browser).

---

## What writes a notice

**A trigger, not the panel.** `agent_billing_notice` fires on every insert and
update of `agent_billing` and writes the agent a plain sentence: approved,
paused (carrying the admin's own note), live again, payment recorded with the
date it now runs to, overdue, cancelled. It is in the database on purpose. A
notice the UI is responsible for sending is a notice somebody eventually
forgets to send, and the one time it matters is the time somebody was in a
hurry.

Only `uid:` keys. `agent_billing` also holds `ph:` keys, which are phone
numbers off a listing with no account behind them; there is nothing to write
to, so they are skipped rather than guessed at.

**A sweep, for the thing that has not happened yet.**
`agent_notices_remind(days)` writes to everybody whose cover runs out inside
the window. It cannot be a trigger, because nothing changes on the day a
subscription starts running out.

It runs **daily at 06:41 UTC** (09:41 in Tanzania, a working morning, because
the message ends with "pay the admin" and an admin who is awake can answer the
phone call it causes). `supabase/features/agent/agent_notices_cron.sql`
schedules it with pg_cron, which this project already uses for three other
jobs. `n8n/07_renewal_reminders.json` is the same job as an importable
workflow, for an instance that wants it there instead; `n8n/README.md` says
which one to turn off if you use it.

**Who may run a sweep** is read from the JWT **role claim**, not from
`current_user`, and that distinction is the whole correctness of the check:
inside a `SECURITY DEFINER` function `current_user` is the function's owner, so
testing it would return `postgres` for every caller alive and let any signed-in
agent write to eighty accounts. No claim at all means the database itself
(pg_cron, a migration, the SQL editor); `service_role` is a key only servers
hold; an admin is an admin. Everything else is refused.

**`dedupe_key` is what makes the sweep safe to run daily.** Each reminder is
keyed by the expiry date it is warning about, so a week of runs writes one row
per agent and a second admin pressing the button changes nothing. A partial
unique index does it; nothing has to remember what it already said.

**`agent_notice_send()` is granted to nobody.** It is the database's own
writer, reached through the trigger and the sweep. A client that could call it
could write to any account and sign it `system`.

---

## What a person sees

| where | what |
|---|---|
| the bell, on the home page, the directory, Profile and all three agent dashboards | two rows: **what the admin said** (a count) and **the subscription** (a state, with no count chip, because an account has one subscription and the question is which state it is in) |
| Profile ▸ From the admin | the list the bell links to (`profile.html#notices`). Opening one reads it. There is no second "mark as read" to forget |
| an agent dashboard | the existing card, now leading with the notice's title and edged by its severity |

`js/lib/notices.js` is the only reader. Three surfaces show the same facts and
must not be able to disagree about them.

**days_left is computed on the server.** A phone with the wrong date would
otherwise tell somebody their cover ends next week when it ended yesterday, and
that is the one number this whole feature exists to get right.

**Neither row can be dismissed from the bell.** They clear by being dealt with:
a notice when it is read, a subscription warning when the subscription is
renewed. A badge that can be tapped away is a badge that lets somebody dismiss
the reminder that their listings come off the board on Friday.

---

## The console

`admin.html` was a phone page stretched to 1440px: one column down the middle,
a 250px photographic hero saying "Admin Panel" to the one person who had to
type the URL and pass two gates to see it, and four tabs in a light bar that
rendered **white on white** in the dark theme, so three of them were invisible.
The same was true of every table header.

`css/admin.css` is the shell: a sticky rail of sections and a work area.
Changing section no longer means scrolling back to the top of a table of two
hundred agents. Under 900px the rail becomes a strip of the same buttons that
scrolls sideways, and the work area takes the width.

`.tab-btn` / `.tab-panel` / `data-tab` are unchanged, so this is a new skin on
the switcher `js/pages/admin.js` has always used rather than a second switcher
to keep in step.

**The white-on-white had one cause and one fix.** Every rule in the page's own
`<style>` reads `--c-*` from `css/claude-design.css`, whose values are a
light-theme cream, while the ink came from the design tokens. The seven names
those rules actually use are now **repointed at the tokens inside `#adminPanel`
only**, so a hundred existing declarations follow the theme without being
rewritten, and `claude-design.css` is left alone for the pages that still want
it.

### Two new sections

**House owners** (`js/pages/admin-owners.js`). The account kind the catalogue
gained in `house_owner_accounts.sql` was invisible to the console, so the one
question an admin gets asked about it had no screen to answer:

> "I cannot post my fourth room. Why?"

The answer is a date, and it is in this table: posts used inside the window,
posts left, and when the oldest one falls out of it. The allowance is read from
`owner_post_limit()` and the window from the ledger, so the console cannot
disagree with the trigger that enforces them.

**Notices** (`js/pages/admin-notices.js`). Write to one account or to an
audience (lapsed, deactivated, ending soon), run the renewal sweep for a window
of days, and read the log of what has gone out and whether it was read. The
audiences are resolved from `agent_billing` in the client, by the same rules
the tracker filters by on screen: an admin looking at eleven lapsed agents
should be writing to those eleven, not to whatever a second definition living
in the database happens to return.

---

## Who can see any of it

Gated three times, and the test that proves it is `tests/admin_access_test.mjs`
(17 assertions):

| visitor | what they get |
|---|---|
| signed out | the sign-in gate |
| a guest | the sign-in gate, with the reason. A guest session is real but has no account, so "you are not authorized" would name an email it has not got |
| an ordinary account | the forbidden card, naming the address it *is* signed in as, so the fix is obvious |
| an allowlisted email that the `admins` **table** does not know | refused. The list in `config.js` ships to every browser; the table is the copy that decides |
| an admin | the console |

In the first four, none of the console is in the page and **none of its tables
are asked for**: the two new sections boot inside `bootAdmin()`, not on page
load. The nav and the Profile tab hide both console links unless `isDbAdmin()`
says yes, and RLS asks the same question again on every row.
