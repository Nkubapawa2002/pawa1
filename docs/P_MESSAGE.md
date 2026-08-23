# P-Message

End-to-end encrypted chat between the people who use the site: someone looking
for a room and the agent who has one, plus admin announcements to a region or
to the whole country. The fourth tab in the app shell.

It is not a wrapper around a chat service. The messages are encrypted in the
browser, stored as ciphertext, and decrypted in the other browser. Supabase is
a post office that cannot open the post.

---

## What is promised, and what is not

This is the most important section in this document. A messaging feature that
overstates its protection is worse than one with none, because people act on
the promise.

**Promised**

- Nobody with database access — including whoever runs this project — can read
  a message body. Not the admin, not a leaked backup, not a subpoenaed dump.
- Only the people in a thread hold a key that opens it, and each one holds only
  their own.
- A ciphertext cannot be moved to another thread, re-attributed to another
  sender, or edited by a single byte without decryption failing outright.

**Not promised, and stated in the UI rather than buried here**

- **Metadata is in the clear.** Who wrote to whom, when, how often, how long
  the message was, **which message a reply answers**, and **when somebody last
  had P-Message open**. The schema does not pretend otherwise, and encrypting
  this would mean a fundamentally different (and much slower) design. The last
  two are newer than the rest and are listed here rather than left implied:
  `pm_messages.reply_to` and `pm_presence.last_seen_at`. Both are held as
  tightly as the design allows — presence is readable through no policy at all,
  only through functions that already decide who may see whom — but "tightly
  held" is not "encrypted" and this document does not blur the two.
- **Key distribution is trust-on-first-use.** Public keys come from the same
  database that stores the messages. Someone who controls that database could
  hand you a key of their own and read what you send from that moment on.
  Two things stand against that. The **safety number** — thirty digits derived
  from the key, shown on both sides, compared out of band — closes the first
  contact. **Pinning** (`js/lib/pm-trust.js`) closes every contact after it:
  the key is written down the first time it is seen and compared on every
  open, and a key that changes stops the conversation until a person deals
  with it. Until two people compare the number once, the guarantee is "the
  server cannot read this without being noticed", not "the server can never
  read this".
- **The key lives on one device.** Clearing the browser's data destroys the
  history, permanently. That is why a brand-new device is offered a passphrase
  backup code *before* it has anything to lose.
- **The assistant thread is not encrypted and never can be.** A model that
  answers you has to read you. It sits in its own pane, with its own warning,
  and opening it flips the header lock to say so. Making the two look alike
  would be the single most dishonest thing this feature could do.

---

## The scheme

All WebCrypto primitives. No dependencies, no build step (`js/lib/p-crypto.js`).

| | |
|---|---|
| identity | ECDH P-256 keypair, generated on the device, private half never leaves it |
| per message | random AES-256-GCM content key, random 96-bit IV |
| body | `AES-GCM(content key, plaintext)`, **AAD = thread id + sender id** |
| key wrapping | one ephemeral ECDH keypair per message; per recipient `ECDH(eph, their pub) → HKDF-SHA256 → AES-GCM` wrap of the content key |
| backup | `PBKDF2-SHA256(210k)` over a passphrase, AES-GCM over the PKCS8 private key |
| safety number | PBKDF2-SHA256(100k) over the public key → 30 digits in six groups |

Three choices worth keeping:

- **HKDF after ECDH, always.** Using the raw X coordinate as a key is the
  classic mistake here: it is not uniformly distributed, and it would be
  identical for every message between the same two people.
- **The KDF info names both parties** (`…|wrap|sender|recipient`), so a wrap
  made for one person cannot be replayed at another even by someone who can
  rewrite the row it sits in.
- **The AAD binds thread and sender.** It is not secret, it is *authenticated* —
  a stored row replayed into a different conversation fails to decrypt instead
  of silently succeeding.
- **The safety number is derived on the device, never fetched.** `pm_keys` has
  a `fingerprint` column and reading it was the original bug: whoever can
  substitute a public key in that row can write the number beside it, so both
  phones would show matching digits for a key neither person owns. The party
  being guarded against cannot be the one supplying the evidence. The column
  survives as a tamper signal — reported when it disagrees, trusted for
  nothing.
- **Thirty digits, not twelve.** 10^12 is about 2^40. An attacker who can swap
  a key can grind ECDH keypairs until one produces the victim's number, and
  2^40 hashes is hours on a commodity GPU. 10^30 (~2^99.6) is not grindable,
  and PBKDF2 makes each attempt a hundred thousand hashes rather than one.

**One body, N wraps.** A message is encrypted once and its content key wrapped
once per recipient. That is what makes an encrypted national broadcast
affordable: 60 recipients seal in about half a second, so the per-person cost is
a small wrap rather than a whole re-encryption. The admin composer shows
progress because a thousand wraps is several seconds of a phone's CPU, and a
screen that looks frozen gets tapped twice.

---

## Verifying without reading digits

Thirty digits is the honest length for a safety number and a hopeless length
for a human comparison: people skim, agree, and have checked nothing. So the
number is also a QR code, and one phone reads the other.

`PM2|<user id>|<thirty digits>`

The user id is in the payload so a scan can tell **"that is the wrong person's
code"** from **"that is the right person with the wrong key"** — very different
things to be told, and the second one is the attack.

Reading is done by `BarcodeDetector`, the phone's own scanner. It does not
exist on iOS Safari or on desktop Chrome, so the button is simply not drawn
there and the digits carry the feature — which is why they were kept. Drawing
is `js/lib/qr.js`, written here rather than installed because the site has no
build step and this sits in the trust path of a verification screen. It is
black on white in both themes: contrast and the quiet zone are part of the
format, and a QR code tinted to match the page is one that does not scan.

## The device lock

Optional, off by default. The private key normally sits in localStorage in the
clear, where any script on the origin — or anyone holding the unlocked phone —
can read it. With the lock on, it is stored wrapped under 32 bytes that only
the phone's secure hardware will produce, via WebAuthn's **PRF extension**, and
getting them back needs a fingerprint, face or PIN.

Three deliberate refusals, all in `js/lib/pm-device-lock.js`:

- **It never turns itself on.** PRF is missing on plenty of real phones.
  `supported()` is a real capability check, and nothing changes when the
  answer is no.
- **No plaintext fallback is left behind.** A second unwrapped copy would make
  the whole thing decoration.
- **It will not enrol without a backup code**, which follows from the previous
  point: if the passkey is reset the sealed key is unopenable by anyone, us
  included. The dialog makes the code first and will not proceed until it has.

**The single most dangerous line in the feature** is the fence in
`ensureIdentity()`: a locked device *has* an identity and simply has not
opened it. Without that check it looks like a brand-new device, generates a
second keypair, publishes it, and every message ever received becomes
permanently unreadable. `p_message_lock_test.mjs` exists mostly to hold that
line.

---

## The database (`supabase/features/message/p_message.sql`)

| table | holds |
|---|---|
| `pm_keys` | who can be written to: public key, safety number, region. World-readable on purpose — a public key is public, and no phone or email lives here |
| `pm_threads` | a conversation: `direct` or `broadcast` |
| `pm_members` | who is in it |
| `pm_messages` | the sealed body: ciphertext + IV, nothing else |
| `pm_message_keys` | the content key, wrapped once per recipient |

RPCs: `pm_publish_key`, `pm_directory`, `pm_start_direct`, `pm_send`,
`pm_recipients`, `pm_broadcast`, `pm_inbox`, `pm_thread_messages`,
`pm_mark_read`.

**Two RLS traps, both already sprung and defused:**

- **Recursion.** "Members are visible to members" is an infinitely recursive
  policy if written directly against `pm_members`. Every membership test goes
  through `pm_is_member()`, which is SECURITY DEFINER and so does not re-enter
  RLS.
- **Per-row function calls.** `app_uid()` and `is_admin()` are called as scalar
  sub-selects — `(select public.app_uid())` — so the planner runs them once per
  query rather than once per row.

**What admins deliberately do NOT have:** a read policy on other people's
threads. It would be useless (the bodies are ciphertext they cannot open) and it
would put "the admin can see your conversations" into the schema, which is the
opposite of what this feature says on the tin. Admins can *delete* a key
(abuse, a lost device) but cannot usefully *replace* one — a swapped key changes
the safety number, which is exactly what that number is for.

Writes never go through a table policy: there is no insert policy on
`pm_messages` at all. Everything is written by `pm_send()` / `pm_broadcast()`,
which check membership first, so a message cannot be forged into a thread by
anyone merely holding the public anon key.

`pm_directory` requires a signed-in caller. The names and operating areas of
every agent in the country are precisely the list a scraper with the anon key
would want, and a signed-out visitor has nobody to message anyway.

---

## Guests — chatting without an account

Someone looking at a room has no reason to make an account before asking "is
this still available?", and a wall there costs the **agent** the enquiry, not
just the visitor the convenience. So P-Message's signed-out screen offers a
guest chat: give a name agents can call you by, and start.

A guest gets an **anonymous Supabase session** — a real auth user with a real
`sub`. That matters: `app_uid()` resolves, RLS applies, and the encryption is
bit-for-bit what a signed-in agent gets. There is no weaker mode for people
without an account. The only difference is that nobody has proved who they are.

**The part that mattered more than the feature.** Turning on anonymous sign-ins
means "authenticated" no longer implies "has an email address". Every policy of
the form

```sql
with check (app_uid() is not null and owner_user_id = app_uid())
```

was, until that moment, a policy only a real account could satisfy. Left alone,
anyone could post house listings, services and trucks without so much as an
email — free, unlimited, untraceable spam in the actual catalogue. So
`p_message_guests.sql` adds `public.app_is_guest()` (the `is_anonymous` JWT
claim) and every content-creating policy gained `and not app_is_guest()`,
restoring exactly the posture that existed before. **The two halves are not
separable: enabling anonymous sign-ins without that file opens the catalogue to
anyone.**

What a guest may do, and nothing else:

| | |
|---|---|
| hold a key | published like anyone's, marked `is_guest` |
| read the directory | agents only |
| open a thread | **with an agent only** — guest-to-guest would be a free unidentified channel between two unidentified people, which is a spam network with our name on it |
| send messages | same encryption, same everything |
| …at a limit | five new conversations an hour; costless accounts plus unlimited threads is the whole spam recipe |

Guests are **not** in the directory (it is for finding agents, not a roll of
every visitor) and **not** in a broadcast (a guest session is a browser tab;
counting it would inflate "sent to 900 people" into a number that means
nothing). `pm_peer()` exists so an agent can still check a guest's safety
number despite that absence.

The cost to the guest is stated up front, on the gate and again on Profile:
**the conversation and the key that opens it live in this browser.** Clearing
it, or changing phone, loses both.

---

## The directory

`agent_profiles` is not world-readable, because it carries a phone number.
`pm_directory()` is a SECURITY DEFINER view over it that returns the working
identity — name, region, **area of operations**, ward, district — and never the
phone. Same privacy model the demand-pin RPCs already use.

`reachable` is the honest signal: an agent who has never opened P-Message has no
published key, so there is nothing to encrypt to. The UI says exactly that
rather than offering a chat that would silently fail.

**The area of operations is the row, not a footnote in it.** It is the only
thing that makes one agent more use than another, and it used to be the first
of up to four place names run together in one grey subtitle —
indistinguishable from the ward, district and region behind it. It now has a
pin, the brand colour and its own element, with the broader place kept
separate and never repeated. An agent who has not set one is *said* to have
not set one: a blank line there reads as "operates nowhere in particular",
which is a claim about them rather than about our data.

The pane asks for **500**, not the default 200 — it is every registered agent
in the country, not a sample. The directory also returns anyone who has merely
opened P-Message, which is right for "who wrote to me?" and wrong for "who can
find me a room", so a second filter separates the two and agents are the
default.

Rooms scoped to nothing and nowhere are exactly **every agent in Tanzania**,
and that was reachable only by knowing that leaving both selects alone meant
it. One button now says so, fills in the name, and runs the roster preview
immediately — the count is what makes a room of a thousand people safe to
press.

### Is anyone there?

The directory could say what somebody deals in and where they work. It could
not answer the question a person actually holds while deciding whether to type:
**is anybody going to read this today.** A list of forty names in which most
have not opened the app since March is a queue with no server, and the only way
to find that out was to write to each of them and wait.

`pm_presence` holds one timestamp per person: when they last had **P-Message
open**. Not when they last loaded the site, not when they published a key —
that exact claim is the only version of it that predicts a reply, and it is why
`p-message.html` is the only page that beats. `js/lib/pm-presence.js` beats
once a minute and again whenever the tab comes back to the front, because a
phone suspends timers the moment the screen locks.

**Where it is contained is the whole design.** `pm_presence` has RLS on and
**not one policy** — the same pattern `day_job_owners` uses. Nothing reads it
directly. It comes back only through functions that already decide who may see
whom: `pm_agent_finder` (signed-in, never guests), `pm_peer` (only somebody you
already share a thread with). There is no "when was this person last online"
call, because no screen needs one and it would be a tracking API.

Truncated to the minute on the way out: seconds would tell an observer when
somebody put the phone down. Three states — online (150s, one number, in the
database, so the dot and the beat keeping it lit cannot drift apart), recently,
and a date past a week. **Null is not zero.** Somebody with no record has not
been away for ever; they have not been seen since this shipped, and every
screen draws *nothing* rather than "last seen never", which would be a claim
about the person instead of about our data.

### What kind of work, and a page to look at it on

"4 services" is the count of a thing whose identity was thrown away one join
earlier: a plumber, a hairdresser and a night guard all read the same on that
row, and the only way to tell them apart was to open four conversations.
`pm_owner_listings` now carries `kind` — `houses.type`, `services.category`,
`trucks.truck_type` — and `pm_agent_finder` returns the top four, narrowed to
the chosen category when there is one. A day job has no kind, because the board
has no categories; guessing one from the title would be a guess printed as a
fact.

The words come from `js/lib/listing-kinds.js`, which is now the only copy —
`services.js`, `trucks.js` and `houses.js` each carried their own, and three
copies of a lookup table is three chances for the truck page to say "7-tonne
lorry" while the agent list says "7ton". Two of the three columns are free
text, so anything unrecognised is title-cased and shown **as typed**, never
replaced with "Other": an unfamiliar kind is still the truest description of
the work available.

`agent.html?u=<user id>` is the storefront — the screen that did not exist.
`pm_agent_card()` and `pm_agent_listings()` fill it, both signed-in only (a
storefront that worked signed-out would enumerate every agent in the country),
both refusing guests, and **neither returning a phone number**. That is the
invariant every function on this directory holds and the easiest one to break
by adding a column.

**About the "link in the bio".** `agent_profiles.bio` is the agent's own words,
plain text, escaped at render. The LINK is not stored anywhere: it is always
`agent.html?u=<their own id>`, derived from the id. A free-text link field on a
public directory row is a phishing surface with a marketing name — it puts an
attacker-chosen destination behind a name the app appears to vouch for. The
link people want is "take me to this agent's services", and that destination is
knowable from the id alone. The URL carries only the id for the same reason
`p-message.html?to=` does: name, area and catalogue all come from the database,
so a doctored link cannot put a borrowed name on the one page whose job is
saying who this is.

An agent reaches the bio from **Profile → Your area and your bio**.
`AgentProfile.ensure()` prompts only when something *required* is missing, so
without `AgentProfile.edit()` the field would have been one nobody whose
profile was already complete could ever fill in.

### Answering one message

A direct thread does not need this. A room does: with thirty agents talking,
"yes, 300,000" answers a question nine messages back and is unreadable without
it.

One column, `pm_messages.reply_to`, pointing at another message **in the same
thread** — checked by `pm_reply_target()`, which both send paths call so the
rule cannot exist in two versions. The quoted text is **not** stored:

- the quote is drawn from the copy the reading device already decrypted, so it
  costs no second ciphertext and can never disagree with the original;
- a stored quote would be a second, independent encryption of the same words —
  twice the surface, and a place a client could put text the original never
  contained;
- somebody who cannot open the quoted message (they joined the room after it
  was sent, or it is outside the page they loaded) sees a neutral "an earlier
  message" and **not** a fabricated preview. A reply to something you are not
  entitled to read must not leak it, and the only way to be sure is never to
  have it to leak.

Both send paths carry it. A room above the sender-key threshold is exactly the
room where replies matter most, so wiring only the small-room path would have
shipped the feature to the conversations that need it least.

---

## Files

```
js/lib/p-crypto.js                      the scheme; pure, no DOM, no network
js/lib/pm-trust.js                      pinned keys and the change alarm; device-only
js/lib/qr.js                            a QR encoder; no dependency, no build step
js/lib/pm-device-lock.js                WebAuthn PRF: the private key sealed by the phone
js/lib/pm-store.js                      identity, calls, decryption; no DOM
js/lib/pm-presence.js                   the heartbeat, and the words for a timestamp
js/lib/listing-kinds.js                 the ONE map from a stored kind to a word
js/pages/p-message.js                   the screen
p-message.html                          markup + styles
agent.html · js/pages/agent.js          one agent's storefront
css/pm-shared.css                       presence, kinds and the link — used by both pages
supabase/features/message/p_message.sql          tables, RLS, RPCs   (APPLIED)
supabase/features/message/p_message_guests.sql   guests + the fence  (APPLIED)
supabase/features/message/p_message_trust.sql    pm_peer returns the key (APPLIED)
supabase/features/message/p_message_presence.sql pm_presence + the beat (APPLIED)
supabase/features/message/p_message_storefront.sql bio, kinds, agent card (APPLIED)
supabase/features/message/p_message_replies.sql  reply_to on both send paths (APPLIED)
js/lib/pm-identity-ui.js                the three key dialogs, shared with Profile
css/pm-identity.css                     their styling, so it travels with them
profile.html · js/pages/profile.js      the account tab
```

Anonymous sign-ins are enabled on the project
(`external_anonymous_users_enabled`). Turning that off disables guest chat;
turning it on without `p_message_guests.sql` opens the catalogue.

`p-message.html` deliberately does **not** load `css/premium.css`: it
force-styles every input and textarea to a near-white glass pill with
`!important`, which is wrong on a dark chat screen. `explore.html` leaves it out
for the same reason.

---

## Tests

| | |
|---|---|
| `tests/p_crypto_test.mjs` | 37 — the scheme, written as attacks: the wrong person opening it, a row moved to another thread, a reused key or IV, a wrong backup passphrase quietly succeeding |
| `tests/p_message_db_test.mjs` | 31 — against the **real database** with RLS actually on (`set local role authenticated` + JWT claims; as `postgres` every policy is bypassed and the test would prove nothing). Writes `pmtest_*` rows and deletes them at both ends |
| `tests/p_message_trust_test.mjs` | 29 — key pinning, written as the ways the alarm could fail to fire or quietly un-fire: re-fetching the substituted key, a reload, a changed key inheriting the old one's verified badge, and a guest session borrowing an account's verdict |
| `tests/qr_test.mjs` | 22 — the QR encoder against a decoder written backwards from it. No decoder exists on this platform (BarcodeDetector is a phone API and the registry is unreachable), so the oracle is Reed-Solomon: if a single module is misplaced the syndromes stop vanishing, and passing that by luck is about 2^-80 |
| `tests/p_message_lock_test.mjs` | 33 — the device lock against Chrome's virtual authenticator, which really does implement PRF. Written around data loss rather than the happy path: is the plaintext gone, is a LOCKED device mistaken for a NEW one, does unlocking return the same key |
| `tests/p_message_layout_test.mjs` | 14 — the conversation as a thing you type into: the composer grows with the message, and the on-screen keyboard does not end up on top of it |
| `tests/p_message_page_test.mjs` | 233 — the page in a browser, including the assertion that matters most: **no request body the page sends contains the message text** — extended to replies, where neither the answer nor the message it quotes may appear in any body — plus presence, the work kinds, the storefront and the whole guest path |
| `tests/p_message_presence_db_test.mjs` | 31 — against the **real database**: that `pm_presence` is readable through no policy at all, that the storefront refuses anon and guests and returns no phone number, and that a reply cannot name a message in another conversation |
| `tests/p_message_guest_test.mjs` | 19 — against the real database: mostly proving the DOWNSIDE was closed (a guest cannot post a house, a service or an agent profile) rather than that the feature works |
| `tests/profile_page_test.mjs` | 41 — Profile's three states, and that a guest is never offered a door the database will refuse |

Run the middle one only when you mean to — it writes to production.

---

## Known gaps

- **The assistant needs its edge function.** `ai-chat` is not deployed, so the
  assistant answers "not available right now". Deploying it without an
  Anthropic key would make it worse, not better.
- **`chat.html` still has its own AI tab**, an older doorway to the same
  `js/lib/ai.js` engine. Not a second engine, but it is a second doorway —
  worth folding into P-Message when the voice agent moves.
- **One device per person.** Adding a second device means restoring the backup
  code onto it; there is no multi-device key sync.
- **A guest cannot upgrade in place.** Signing in after chatting as a guest
  starts a fresh identity; the guest thread stays with the guest session. Moving
  a thread across would mean re-wrapping every message key to the new identity —
  doable, and not done.
- **Presence is per person, not per device.** Two devices signed into one
  account write to one row, so "online" means one of them is. Splitting it
  would mean holding a row per device, which is more tracking, not less.
- **Day jobs have no detail page**, so a job card on a storefront leads to the
  jobs board rather than to the job. One line in `js/pages/agent.js`
  (`listingHref`) when they grow one.
- **No attachments and no push notifications.** A photo of a room is a natural
  next thing to send, and both are real work: encrypting a blob and storing it,
  and waking a phone without leaking who is talking to whom.
