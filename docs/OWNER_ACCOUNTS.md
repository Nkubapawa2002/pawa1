# Owner accounts — the landlord who is not an agent

`js/lib/login-doors.js` has offered four doors since it was written, and one of
them carries a VIP mark:

> **House owner.** Your own property, listed by you, with no agent in between.

Until now that door was a signpost and nothing else. Its own header says so: it
grants nothing, it is stored in Supabase **user metadata**, and metadata is
writable by the user it describes. So a landlord walking through it landed in
exactly the agent's building.

Three things were wrong with that, and they are the three this feature fixes.

**They were billed like an agent.** `agent_key_suspended()` gives a new poster
seven days and then hides every listing they have until an admin approves them
and a monthly fee is paid. The one thing the VIP door promises is the one thing
they did not get.

**Nothing said the listing came from the owner.** A renter reading the board
could not tell the room with no agent margin on it from the twenty with one,
which is the only reason the distinction is worth having.

**And there was no ceiling.** "No fee" with no ceiling is a free listing board,
which is a spam board with our name on it by the end of the month.

---

## The shape of it

| | agent account | owner account |
|---|---|---|
| monthly fee | yes, plus a 7-day approval gate | none |
| listings | unlimited | **3 posts every 180 days** |
| agent commission on a listing | whatever they state, or the market month | forced to zero |
| badge on the card | none | "From the owner" |
| asked for an "area of operations" | yes | no |
| reachable by a guest in P-Message | yes | yes |

Everything above is enforced in the database. The screen only ever repeats it.

`supabase/features/house/house_owner_accounts.sql` — **APPLIED to production.**
Run it AFTER `agent_billing_setup.sql` and `p_message_guests.sql`: it redefines
`agent_key_suspended` and `pm_start_direct`, so re-running either of those files
would put the fee back on every owner and make owners unreachable by guests.

Proof: `node tests/house_owner_test.mjs` (35 assertions, RLS on, against the
real database).

---

## account_kinds: the server's own answer

```sql
create table public.account_kinds (
  user_id text primary key,
  kind    text check (kind in ('agent','owner','company','user')),
  set_at  timestamptz,
  set_by  text        -- 'self', or the admin who moved them
);
```

The four words are `login-doors.js`'s, so there is one vocabulary rather than
two that have to be kept in step. **An account with no row here is an agent**,
which is what every account was before the table existed: a new table must not
change what happens to accounts that are not in it.

`account_kind_claim(kind)` is how a row appears. It is called at the first
sign-in that knows the door (`js/pages/login.js`) and again every time the
listing dashboard opens (`js/pages/agent-houses.js`), so an account that
predates the table is corrected the first time its owner looks at it. Claiming
the same kind twice is not an error.

**Claiming `owner` is claiming an exemption from a fee, so that one claim is
checked.** It is refused for an account that already has an `agent_profiles`
row, and for one already holding more listings than the allowance would ever
have let it post. `account_kind_set(uid, kind)` is the admin door for the cases
a rule should not try to guess at.

There is nothing to guard in the other direction. An owner who wants more than
three posts in six months may become an agent whenever they like, and an agent
pays the fee and waits for approval. The two rules hold each other up.

---

## The allowance, and why it is a ledger

```sql
public.owner_post_limit()   -- 3
public.owner_post_window()  -- interval '180 days'
```

Two functions rather than two literals in four triggers, an RPC and a screen.
Changing "three posts in six months" to any other pair of numbers is one edit,
and `owner_post_quota()` reads the same two functions the trigger reads, so the
sentence a landlord sees can never disagree with the rule that stops them.

Every post is written to `public.owner_posts` (user, kind, item id, when) by
the `owner_post_gate` trigger, which fires `before insert` on **houses, trucks
and services**. One shared allowance across the three, on purpose: an owner
account that could post three of each for nothing would be an agent paying
nothing.

**The ledger row outlives the listing, and that is the whole point.** Counting
live rows would make the allowance mean "three at a time", and three at a time
with a delete button is unlimited posting with extra steps.

### The edit path is not a hole

Editing a listing is free and always will be: it is the same room, with a
better photograph. What must not happen is an edit that quietly becomes a post.

- **Database.** Only `INSERT` is counted and only `INSERT` sets
  `posted_by_owner`. An `UPDATE` can manufacture neither, and
  `houses_hold_owner_flag` pins the flag (and the zeroed fee) on every update,
  so a client cannot award itself the badge by writing to its own row.
- **Screen.** `js/pages/agent-houses.js` keeps `openedForEdit` separately from
  `editingId`. They can only come apart one way, and that way is a bug: a form
  opened on an existing listing that has lost the id it was editing. The save
  stops with a sentence rather than falling through to an insert, because on an
  owner account an insert spends one of three posts for six months.

---

## posted_by_owner, and the fee that is actually zero

`houses.posted_by_owner boolean not null default false`, set by the trigger at
insert. Two reasons it is denormalised onto the listing rather than joined from
`account_kinds`:

- `account_kinds` is readable only by its own account. Making it world-readable
  to draw one badge would publish what kind of account every person on the site
  keeps.
- a column the client writes is a badge the client can award itself.

The same trigger forces `agent_fee_tzs = 0` on an owner's listing. "No agent
fees" is then a fact about the row rather than a claim on a card, and it has to
be, because of what the money card does with a missing fee: `house-rooms.js`
**assumes the market's one month's rent** when no commission is stated. On an
owner's listing that assumption would invent the single largest cost on the
page and print it directly under a card saying there is no agent fee. So the
commission line now reads "Free, no agent on this listing", the total drops it,
and the label under "To move in" stops naming a cost that is not in it.

---

## On screen

| where | what |
|---|---|
| `index.html` | a "Straight from the owner" rail, hidden entirely when there is nothing in it, and a gold chip on any owner card |
| `houses.html` | the same chip in the directory, plus `?owner=1` for an owner-only view with a chip that says so and takes it off again |
| `house.html` | "Listed by the owner" instead of "Listing agent", the "No agent fee" note, and a move-in total with no invented commission |
| `agent-houses.html` | the allowance panel (`3/3`, gold; `0/3`, red), "New listing" locked at the ceiling, no subscription banner, and none of the agent-business coaching |

`js/lib/owner-account.js` draws the badge, and it is the only thing that draws
it, so "from the owner" cannot mean one thing on the home page and something
subtly different in the directory. `css/owner-badge.css` is the styling, in
tokens, linked from all four pages. **Gold, not green**: green already means
verified on the same photograph, and the two are different claims.

The numbers on the account panel come down from `owner_post_quota()`. Nothing
about the allowance is written in JavaScript.

---

## What an owner is NOT asked

`AgentProfile.ensure()` opens a modal asking for an "area of operations" and
writes an `agent_profiles` row. That row is what makes somebody an agent
everywhere else in this app: `pm_publish_key` reads exactly it to set
`pm_keys.is_agent`. Asking a landlord with one house an agent's question and
then filing them as an agent for answering it is how the VIP door would have
quietly stopped meaning anything, so the dashboard establishes the account kind
first and skips the modal for an owner.

That has one consequence worth knowing, and it is handled in the same
migration: **an owner is not an agent in `pm_keys`**, and
`p_message_guests.sql` lets a guest open a conversation only with an agent. So
`pm_start_direct` now admits agents *and* owner accounts. Guest-to-guest is
still refused and the five-new-threads-an-hour ceiling is untouched, which is
the part that actually stops a flood.
