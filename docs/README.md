# Pawa Bus Cargo — Tanzania

A text-based website for organizing parcel shipments across all 26 mainland Tanzania regions via intercity buses. Includes Supabase database, AI chat assistant, live tracking, agent communication, and 80% loss insurance.

## Features

- **Send a parcel** with sender, receiver, product, declared value (and 80% insurance preview)
- **Track** orders three ways: by code, by sender phone/name, by receiver phone/name
- **Live realtime updates** when status changes or messages arrive (via Supabase realtime)
- **Messaging thread** on each shipment — sender, receiver, and agents can chat
- **Quick actions** for agents: "Notify Arrival" and "Confirm Pickup" (also updates status)
- **WhatsApp + Call buttons** on every agent and bus contact
- **Bilingual UI** — English / Swahili, fully translated (toggle in nav)
- **AI chat** powered by Anthropic Claude (or local keyword fallback)
- **Admin panel** for managing all shipments and statuses
- **Loss insurance** — automatic 80% coverage of declared value

## File structure

```
bus web/
├── index.html          # landing page
├── send.html           # register a shipment
├── track.html          # track by code, sender, or receiver
├── chat.html           # AI assistant
├── agents.html         # agent directory
├── buses.html          # bus directory
├── admin.html          # admin panel
├── css/styles.css
├── js/
│   ├── config.js       # Supabase + Anthropic keys (edit me)
│   ├── i18n.js         # full English/Swahili dictionary
│   ├── data.js         # Supabase + offline JSON data layer
│   ├── nav.js          # shared navigation
│   ├── messages.js     # shipment message thread
│   ├── send.js, track.js, agents.js, buses.js, admin.js, chat.js
├── data/               # offline JSON fallbacks (used if Supabase not configured)
└── supabase/
    ├── schema.sql      # tables + RLS policies + realtime
    └── seed.sql        # all sample agents, buses, shipments
```

## Setup

### 1. Run SQL in your Supabase project

Open **SQL Editor** in the Supabase dashboard and run these in order:

1. `supabase/schema.sql` — base tables + RLS + realtime
2. `supabase/seed.sql` — regions, buses, agents, sample shipments
3. `supabase/schema_v2.sql` — admins, agent applications, ratings, photos, route helpers
4. `supabase/photos.sql` — maps each bus to its photo file (run **after** step 5 below)

### 2. Create the photos bucket and upload images

1. **Storage > New bucket** → name `bus-photos`, **Public: ON**
2. Open the bucket, drag-drop all 10 jpg files from `bus web/data/`
   into it (keep the original filenames)
3. Now run `supabase/photos.sql`

### 3. Enable Email auth and create the admin account

1. **Authentication > Providers** → enable **Email**
2. *(optional but easier for testing)* turn off "Confirm email"
3. Open `admin.html` in the site, type your authorized admin email
   (default: `pawa4761@gmail.com`) + a password, click **create admin account**
4. The email must already be in the `admins` table. The seed inserts
   `pawa4761@gmail.com`. To add more admins, run:

   ```sql
   insert into admins (email, full_name) values ('me@example.com', 'Me');
   ```

5. To add an email to `APP_CONFIG.ADMIN_EMAILS` (browser-side allow-list),
   edit `js/config.js`.

### 4. Run a local server

```bash
# Python 3
python -m http.server 8080

# or Node
npx serve "bus web"
```

Open `http://localhost:8080/bus%20web/` (or just `http://localhost:8080/` if you served from inside the folder).

If `SUPABASE_URL` is empty, the site falls back to the local JSON files in `data/` and stores new shipments in browser localStorage.

## What's in v2 (admin / agent / trust)

- **Admin gate** — `admin.html` is locked behind Supabase Auth. Only emails in
  the `admins` table AND in `APP_CONFIG.ADMIN_EMAILS` can pass. Non-admin
  visitors don't even see the Admin link in the nav.
- **Agent self-registration** — `agent-register.html` lets anyone apply to
  become an agent. Conditions: ≥ 1 bus picked, ≥ 1 region, ≥ 1 year experience,
  national ID required. Submissions land in `agent_applications` (status
  `pending`).
- **Approval workflow** — Admin tab "Agent applications" lists pending apps.
  One click runs the `approve_agent_application` RPC which inserts the row
  into `agents` (auto-generated AGxxx id, `verified = true`).
- **Easy route editor** — Admin tab "Routes" picks bus + from + to + departure
  times + duration, then calls `add_bus_route`. The function adds **both legs**
  (forward and return) so every region you connect has a return path.
- **Bus photos** — public `bus-photos` bucket; resolved via
  `DataStore.busPhotoUrl(path)`.
- **Trust signals** — `verified` badge, star rating + review count on every
  agent. After a shipment is `Delivered`, sender or receiver can rate both
  agents on `track.html`. Ratings flow into `agent_reviews`; trigger
  recomputes `agents.rating_avg` / `rating_count`.
- **Realtime** — applications and reviews stream live in the admin panel.

## Insurance

Every parcel is automatically insured for **80% of the declared value**. The percentage is configurable in `js/config.js`:

```js
INSURANCE_COVERAGE_PERCENT: 80
```

## Communication features

- **Messages thread** on every shipment detail. Anyone with the tracking code can post.
- **Realtime sync**: when an agent posts a message or updates status, the receiver's tracking page updates automatically (no refresh).
- **WhatsApp deep links** open chat with the agent's number directly.
- **Tel links** start a phone call (mobile only).
- **Quick action buttons** for agents:
  - "Notify Arrival" → posts a message + sets status to Arrived
  - "Confirm Pickup" → posts a message + sets status to Delivered

## Security notes

- The anon key with the demo RLS policies allows public read/write. **Before production**, add proper authentication and tighten policies in `supabase/schema.sql`.
- Anthropic API key in a static page is visible in source. For production, route AI calls through a backend proxy.

## Languages

Toggle EN/SW in the top-right corner of any page. Every UI string, button, label, hint, and message is fully translated. The AI chat auto-detects the user's language.
