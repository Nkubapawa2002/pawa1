# n8n AI Logs Workflows — Setup Guide

Four workflows that power the **AI Logs** tab in the Pawa dashboard.

---

## Step 1 — Set your n8n URL in config.js

Open `js/config.js` and replace:
```
N8N_WEBHOOK_BASE: "https://your-n8n.yourdomain.com",
```
with your actual n8n domain (e.g. `https://n8n.pawa.app`).

---

## Step 2 — Import the 4 workflows into n8n

In n8n: **Workflows → Import from file** — import each JSON file:

| File | Webhook path | What it reads |
|---|---|---|
| `workflow-1-active-calls.json` | `POST /webhook/ai/active-calls` | VAPI live API |
| `workflow-2-call-history.json` | `POST /webhook/ai/call-history` | Google Sheets: Calls Log |
| `workflow-3-messages.json` | `POST /webhook/ai/messages` | Google Sheets: Messages Log |
| `workflow-4-ai-responses.json` | `POST /webhook/ai/responses` | Google Sheets: AI Responses |

---

## Step 3 — Create credentials in n8n

### VAPI Bearer Auth (for workflow 1)
1. n8n → Credentials → New → **HTTP Bearer Auth**
2. Token: paste your **VAPI private key** (`vapi_priv_...`)
3. Name it `VAPI Bearer Auth`
4. Open workflow 1, click the "VAPI Get Active Calls" node, set credential

### Google Sheets OAuth2 (for workflows 2, 3, 4)
1. n8n → Credentials → New → **Google Sheets OAuth2**
2. Follow the Google OAuth consent screen
3. Name it `Google Sheets OAuth2`
4. Apply to all three Google Sheets nodes

---

## Step 4 — Configure your Spreadsheet IDs

In each of workflows 2, 3, 4:
1. Click the Google Sheets node
2. Replace `REPLACE_WITH_YOUR_SPREADSHEET_ID` with your actual Google Sheet ID
   - The ID is in the URL: `docs.google.com/spreadsheets/d/**SPREADSHEET_ID**/edit`
3. Confirm the sheet tab name matches:
   - Workflow 2 → sheet name: `Calls Log`
   - Workflow 3 → sheet name: `Messages Log`
   - Workflow 4 → sheet name: `AI Responses`
   (Rename your actual sheet tabs to match, or update the node)

---

## Step 5 — Expected Google Sheet column headers

Your sheets should have these column names in row 1 (the workflows also
try common variations, so exact casing is flexible):

**Calls Log** sheet:
```
call_id | phone_number | direction | status | duration_seconds | summary | created_at | ended_at | tenant_slug
```

**Messages Log** sheet:
```
message_id | phone_number | channel | direction | content | ai_reply | sent_at | tenant_slug
```
- `channel`: `sms` or `whatsapp`
- `direction`: `inbound` or `outbound`

**AI Responses** sheet:
```
session_id | phone_number | channel | user_message | ai_response | intent | model | timestamp | tenant_slug
```

---

## Step 6 — Activate all 4 workflows

Toggle each workflow to **Active** in n8n. The webhooks become live immediately.

---

## How data flows into the sheets

Your existing n8n workflows (for VAPI calls, AT SMS, WhatsApp) should
log each interaction as a new row in the appropriate sheet. Add a
**Google Sheets → Append Row** node at the end of each existing workflow,
writing to the sheet above. The `tenant_slug` column is critical — it
lets the dashboard filter data per company.
