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
  the message was. The schema does not pretend otherwise, and encrypting this
  would mean a fundamentally different (and much slower) design.
- **Key distribution is trust-on-first-use.** Public keys come from the same
  database that stores the messages. Someone who controls that database could
  hand you a key of their own and read what you send from that moment on. The
  defence is the **safety number**: twelve digits, shown on both sides, compared
  out of band — aloud, on a call, in person. Until two people do that, the real
  guarantee is "the server cannot read this passively", not "the server can
  never read this".
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
| safety number | SHA-256 of the public key → 12 digits in three groups |

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

**One body, N wraps.** A message is encrypted once and its content key wrapped
once per recipient. That is what makes an encrypted national broadcast
affordable: 60 recipients seal in about half a second, so the per-person cost is
a small wrap rather than a whole re-encryption. The admin composer shows
progress because a thousand wraps is several seconds of a phone's CPU, and a
screen that looks frozen gets tapped twice.

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

---

## Files

```
js/lib/p-crypto.js                      the scheme; pure, no DOM, no network
js/lib/pm-store.js                      identity, calls, decryption; no DOM
js/pages/p-message.js                   the screen
p-message.html                          markup + styles
supabase/features/message/p_message.sql        tables, RLS, RPCs   (APPLIED)
supabase/features/message/p_message_guests.sql guests + the fence  (APPLIED)
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
| `tests/p_crypto_test.mjs` | 36 — the scheme, written as attacks: the wrong person opening it, a row moved to another thread, a reused key or IV, a wrong backup passphrase quietly succeeding |
| `tests/p_message_db_test.mjs` | 31 — against the **real database** with RLS actually on (`set local role authenticated` + JWT claims; as `postgres` every policy is bypassed and the test would prove nothing). Writes `pmtest_*` rows and deletes them at both ends |
| `tests/p_message_page_test.mjs` | 47 — the page in a browser, including the assertion that matters most: **no request body the page sends contains the message text**, and the whole guest path |
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
- **Safety numbers are shown but not remembered.** There is no "verified"
  state that would warn you if a contact's key later changed. That warning is
  the part that turns trust-on-first-use into something stronger.
- **One device per person.** Adding a second device means restoring the backup
  code onto it; there is no multi-device key sync.
- **A guest cannot upgrade in place.** Signing in after chatting as a guest
  starts a fresh identity; the guest thread stays with the guest session. Moving
  a thread across would mean re-wrapping every message key to the new identity —
  doable, and not done.
- **No attachments and no push notifications.** A photo of a room is a natural
  next thing to send, and both are real work: encrypting a blob and storing it,
  and waking a phone without leaking who is talking to whom.
