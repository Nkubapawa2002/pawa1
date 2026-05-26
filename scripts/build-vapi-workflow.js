// =====================================================================
// Generator for the Pawa VAPI Tools n8n workflow.
//
// Output: n8n/10_vapi_tools_v2.json — a single workflow with one webhook
// chain per VAPI tool. Importable into n8n cloud / self-hosted.
//
// To regenerate after schema changes:
//   node scripts/build-vapi-workflow.js
//
// Why a generator instead of hand-edited JSON:
//   - 6 tool chains × ~5 nodes each + connections = error-prone in raw JSON
//   - Schema-shaped SQL is easier to read here than escaped in JSON strings
//   - Single source of truth: IDs, positions, and connections derive from
//     the toolName, so adding a tool means appending one object below.
// =====================================================================

const fs   = require("node:fs");
const path = require("node:path");

const OUT = path.join(__dirname, "..", "n8n", "10_vapi_tools_v2.json");

// ---- Standard helpers used inside Code-nodes -----------------------------
// All input parsing collapses to a single shape regardless of whether VAPI
// posted the new toolCalls envelope, the legacy toolCallList, or a raw body.
const PARSE_BOOT = `
const body = $input.first().json.body || $input.first().json;
const tenantSlug =
  body.message?.assistantOverrides?.variableValues?.tenant_slug
  || body.message?.variableValues?.tenant_slug
  || body.tenant_slug
  || 'bus-tz-pawa';
const tc = (body.message?.toolCalls || body.message?.toolCallList || [{}])[0] || {};
const toolCallId = tc.id || 'manual';
let args = tc.function?.arguments ?? body.arguments ?? body;
if (typeof args === 'string') { try { args = JSON.parse(args); } catch(e) { args = {}; } }
`.trim();

// VAPI expects { results: [{ toolCallId, result }] }
const RESPOND_NODE = (id, x, y) => ({
  parameters: { respondWith: "json", responseBody: "={{ $json }}", options: {} },
  id, name: id, type: "n8n-nodes-base.respondToWebhook",
  typeVersion: 1.1, position: [x, y],
});

// ---- Tool definitions ----------------------------------------------------
// Each tool: webhookPath, parseExtra, sqlQuery, sqlParams (array of expressions),
// formatJs (string code that turns rows → human-friendly "result" text).

const tools = [
  // ====== search_trips ======
  {
    name: "search_trips",
    parsePath: "vapi/search-trips",
    parseExtra: `
return [{ json: {
  tenant_slug: tenantSlug,
  toolCallId,
  origin:      args.origin,
  destination: args.destination,
  date:        args.date,
} }];`,
    sqlQuery: `
WITH route_buses AS (
  SELECT b.id AS bus_id, b.name AS bus_name, b.seats_total, b.fare_per_km,
         r->>'from' AS origin, r->>'to' AS destination,
         r->>'departure' AS departure_time,
         COALESCE((r->>'duration_hours')::numeric, 0) AS duration_hours
  FROM buses b, jsonb_array_elements(b.routes) r
  WHERE LOWER(r->>'from') = LOWER($1)
    AND LOWER(r->>'to')   = LOWER($2)
    AND (b.tenant_slug = $4 OR $4 IS NULL OR $4 = '')
), recent_fare AS (
  SELECT bk.bus_id, bk.origin, bk.destination, bk.departure_time,
         PERCENTILE_DISC(0.5) WITHIN GROUP (ORDER BY bk.fare_tzs) AS median_fare
  FROM bookings bk
  WHERE bk.status IN ('confirmed','pending','rescheduled')
    AND bk.fare_tzs IS NOT NULL AND bk.fare_tzs > 0
  GROUP BY 1,2,3,4
)
SELECT rb.bus_id, rb.bus_name, rb.origin, rb.destination,
       rb.departure_time, rb.duration_hours, rb.seats_total,
       COALESCE(rf.median_fare, GREATEST(rb.fare_per_km * 200, 15000)) AS suggested_fare,
       (rb.seats_total - COALESCE((
         SELECT COUNT(*) FROM bookings bk
         WHERE bk.bus_id = rb.bus_id
           AND bk.travel_date = $3::date
           AND bk.departure_time = rb.departure_time
           AND bk.status IN ('pending','confirmed','rescheduled')
       ), 0)) AS available_seats
FROM route_buses rb
LEFT JOIN recent_fare rf
  ON rf.bus_id = rb.bus_id
 AND rf.origin = rb.origin
 AND rf.destination = rb.destination
 AND rf.departure_time = rb.departure_time
ORDER BY rb.departure_time;`,
    sqlParams: ["origin", "destination", "date", "tenant_slug"],
    formatJs: `
const rows = $input.all().map(i => i.json);
const toolCallId = $('parse_search_trips').first().json.toolCallId;
let result;
if (!rows.length) {
  result = 'Samahani, hakuna basi linaloendesha kati ya hizo mbili. Je, ungependa kuangalia mji mwingine?';
} else {
  result = 'Mabasi yanayopatikana:\\n' + rows.map((r,i) => {
    const fare = Number(r.suggested_fare).toLocaleString();
    return \`\${i+1}. \${r.bus_name} (\${r.bus_id}) | kuondoka \${r.departure_time} | viti vinavyobaki: \${r.available_seats} | bei takriban TZS \${fare}\`;
  }).join('\\n');
}
return [{ json: { results: [{ toolCallId, result }] } }];`,
  },

  // ====== reserve_seat ======
  // Finds the lowest-numbered free seat for that (bus, date, departure) and
  // creates a HELD booking with a 12m54s expiry. The bus's ticket_prefix +
  // ticket_seq sequencing comes from the existing buses table, but we keep
  // it simple here and generate a code from now() if no prefix is set.
  {
    name: "reserve_seat",
    parsePath: "vapi/reserve-seat",
    parseExtra: `
return [{ json: {
  tenant_slug: tenantSlug,
  toolCallId,
  bus_id:          args.bus_id,
  travel_date:     args.travel_date || args.date,
  departure_time:  args.departure_time || args.departure,
  passenger_name:  args.passenger_name,
  passenger_phone: args.passenger_phone,
  fare_tzs:        args.fare_tzs || 0,
  origin:          args.origin || '',
  destination:     args.destination || '',
} }];`,
    sqlQuery: `
WITH bus AS (
  SELECT id, name, seats_total, tenant_id, tenant_slug,
         COALESCE(ticket_prefix, 'BK') AS prefix
  FROM buses WHERE id = $1
), taken AS (
  SELECT seat_number FROM bookings
  WHERE bus_id = $1
    AND travel_date = $2::date
    AND departure_time = $3
    AND status IN ('pending','confirmed','rescheduled')
), free_seat AS (
  SELECT s.n AS seat_number
  FROM bus, generate_series(1, bus.seats_total) AS s(n)
  WHERE s.n NOT IN (SELECT seat_number FROM taken)
  ORDER BY s.n LIMIT 1
), code AS (
  SELECT (SELECT prefix FROM bus)
         || to_char(now(),'YYMMDDHH24MI')
         || lpad((floor(random()*1000))::text, 3, '0') AS tc
), ins AS (
  INSERT INTO bookings (
    ticket_code, bus_id, bus_name, origin, destination,
    travel_date, departure_time, seat_number,
    passenger_name, passenger_phone, fare_tzs,
    status, expires_at, tenant_id, tenant_slug
  )
  SELECT
    (SELECT tc FROM code),
    bus.id, bus.name, $7, $8,
    $2::date, $3, (SELECT seat_number FROM free_seat),
    $4, $5, $6::numeric,
    'pending', now() + interval '12 minutes 54 seconds',
    bus.tenant_id, bus.tenant_slug
  FROM bus
  WHERE EXISTS (SELECT 1 FROM free_seat)
  RETURNING ticket_code, seat_number, expires_at, fare_tzs, bus_name
)
SELECT ticket_code, seat_number, expires_at, fare_tzs, bus_name FROM ins;`,
    sqlParams: ["bus_id","travel_date","departure_time","passenger_name","passenger_phone","fare_tzs","origin","destination"],
    formatJs: `
const row = $input.first()?.json;
const toolCallId = $('parse_reserve_seat').first().json.toolCallId;
let result;
if (!row || !row.ticket_code) {
  result = 'Samahani, viti vyote vimeshachukuliwa kwa safari hii. Je, ungependa siku au saa nyingine?';
} else {
  const expMs = new Date(row.expires_at).getTime() - Date.now();
  const mins  = Math.max(0, Math.floor(expMs / 60000));
  const fare  = Number(row.fare_tzs || 0).toLocaleString();
  result = \`Nzuri! Nimekuhifadhia kiti namba \${row.seat_number} kwenye \${row.bus_name}. Tiketi yako ni \${row.ticket_code}. Una dakika \${mins} kulipa TZS \${fare} kabla kushusha kiti.\`;
}
return [{ json: { results: [{ toolCallId, result, ticket_code: row?.ticket_code }] } }];`,
  },

  // ====== get_payment_status ======
  // Returns the latest payment row for that ticket_code (reference).
  {
    name: "get_payment_status",
    parsePath: "vapi/payment-status",
    parseExtra: `
return [{ json: { tenant_slug: tenantSlug, toolCallId, ticket_code: args.ticket_code } }];`,
    sqlQuery: `
SELECT p.status, p.amount_tzs, p.method, p.paid_at, p.error_message,
       b.passenger_name, b.seat_number, b.bus_name, b.status AS booking_status
FROM bookings b
LEFT JOIN payments p
  ON p.reference = b.ticket_code
WHERE b.ticket_code = $1
ORDER BY p.created_at DESC NULLS LAST
LIMIT 1;`,
    sqlParams: ["ticket_code"],
    formatJs: `
const row = $input.first()?.json;
const toolCallId = $('parse_get_payment_status').first().json.toolCallId;
let result;
if (!row) {
  result = 'Samahani, hakuna tiketi yenye hiyo namba.';
} else if (row.status === 'completed' || row.booking_status === 'confirmed') {
  result = \`Malipo yamekamilika. Kiti namba \${row.seat_number}, basi \${row.bus_name}. Asante!\`;
} else if (row.status === 'pending' || row.status === 'processing' || row.status === 'awaiting_payment') {
  result = 'Malipo bado yanasubiri. Tafadhali thibitisha USSD kwenye simu yako.';
} else if (row.status === 'failed' || row.status === 'cancelled' || row.status === 'expired') {
  result = \`Malipo hayakukamilika (\${row.status}). Tunaweza kujaribu njia nyingine?\`;
} else {
  result = 'Bado tunasubiri malipo. Tafadhali ngoja sekunde chache.';
}
return [{ json: { results: [{ toolCallId, result, payment_status: row?.status, booking_status: row?.booking_status }] } }];`,
  },

  // ====== send_ticket_sms ======
  // Africa's Talking call is left INACTIVE — flip it on after credentials
  // are configured in n8n (HTTP node → set its credential).
  {
    name: "send_ticket_sms",
    parsePath: "vapi/send-ticket",
    parseExtra: `
return [{ json: { tenant_slug: tenantSlug, toolCallId, ticket_code: args.ticket_code } }];`,
    sqlQuery: `
SELECT ticket_code, passenger_name, passenger_phone,
       bus_name, origin, destination, travel_date, departure_time,
       seat_number, fare_tzs, status
FROM bookings WHERE ticket_code = $1
LIMIT 1;`,
    sqlParams: ["ticket_code"],
    formatJs: `
// Build the SMS body, log it to message_log via the next Postgres node will
// do (see workflow connections). The actual AT send is via the disabled
// HTTP node below; enable after configuring credentials.
const row = $input.first()?.json;
const toolCallId = $('parse_send_ticket_sms').first().json.toolCallId;
if (!row) {
  return [{ json: { results: [{ toolCallId, result: 'Samahani, tiketi haijapatikana.' }] } }];
}
const date = String(row.travel_date).slice(0,10);
const body = \`PAWA BUS TICKET\\nCode: \${row.ticket_code}\\n\${row.passenger_name}\\nSeat \${row.seat_number} on \${row.bus_name}\\n\${row.origin} -> \${row.destination}\\n\${date} \${row.departure_time}\\nFare TZS \${Number(row.fare_tzs).toLocaleString()}\`;
return [{ json: { results: [{ toolCallId, result: 'SMS ya tiketi imetumwa.', sms_body: body, to_phone: row.passenger_phone, ticket_code: row.ticket_code } ], _sms: { to: row.passenger_phone, body, ref: row.ticket_code } } }];`,
  },

  // ====== cancel_booking ======
  // mode='reschedule' marks the booking 'cancelled' and refund_tzs=0 (the
  // customer chooses a new trip via a separate reserve_seat call).
  // mode='refund' marks 'cancelled' with refund_tzs = 80% of fare_tzs.
  {
    name: "cancel_booking",
    parsePath: "vapi/cancel-booking",
    parseExtra: `
return [{ json: {
  tenant_slug: tenantSlug, toolCallId,
  ticket_code: args.ticket_code,
  mode:        args.mode || 'refund',
} }];`,
    sqlQuery: `
WITH src AS (
  SELECT ticket_code, status, fare_tzs FROM bookings WHERE ticket_code = $1
)
UPDATE bookings b
   SET status      = 'cancelled',
       cancelled_at = now(),
       refund_tzs   = CASE WHEN $2 = 'refund' THEN ROUND(b.fare_tzs * 0.80) ELSE 0 END
  FROM src
 WHERE b.ticket_code = src.ticket_code
   AND b.status IN ('pending','confirmed','rescheduled')
RETURNING b.ticket_code, b.status, b.refund_tzs, b.passenger_name, b.seat_number, b.bus_name;`,
    sqlParams: ["ticket_code","mode"],
    formatJs: `
const row = $input.first()?.json;
const toolCallId = $('parse_cancel_booking').first().json.toolCallId;
let result;
if (!row) {
  result = 'Samahani, tiketi hiyo haijapatikana au tayari imeshafutwa.';
} else if (Number(row.refund_tzs) > 0) {
  result = \`Sawa, tiketi \${row.ticket_code} imefutwa. Utarudishiwa TZS \${Number(row.refund_tzs).toLocaleString()} kwa namba uliyolipa nayo.\`;
} else {
  result = \`Sawa, tiketi \${row.ticket_code} imefutwa. Tuanze kuhifadhi safari mpya?\`;
}
return [{ json: { results: [{ toolCallId, result, ticket_code: row?.ticket_code }] } }];`,
  },

  // ====== create_meet_room ======
  // Inserts a meet_rooms row with a short code, expires in 2 hours.
  {
    name: "create_meet_room",
    parsePath: "vapi/create-meet-room",
    parseExtra: `
return [{ json: {
  tenant_slug: tenantSlug, toolCallId,
  purpose:        args.purpose || 'meet',
  tracking_code:  args.tracking_code || null,
} }];`,
    sqlQuery: `
INSERT INTO meet_rooms (code, purpose, tracking_code, created_by, expires_at, status)
SELECT upper(substring(md5(random()::text) for 6)),
       $1::text, NULLIF($2,''),
       'vapi', now() + interval '2 hours', 'active'
RETURNING code, purpose, expires_at;`,
    sqlParams: ["purpose","tracking_code"],
    formatJs: `
const row = $input.first()?.json;
const toolCallId = $('parse_create_meet_room').first().json.toolCallId;
const result = row
  ? \`Chumba cha kukutana kimefunguliwa. Code: \${row.code}. Itakuwa wazi kwa masaa mawili.\`
  : 'Samahani, sikuweza kufungua chumba sasa hivi.';
return [{ json: { results: [{ toolCallId, result, room_code: row?.code }] } }];`,
  },

  // ====== track_shipment ======
  {
    name: "track_shipment",
    parsePath: "vapi/track-shipment",
    parseExtra: `
return [{ json: { tenant_slug: tenantSlug, toolCallId, tracking_code: args.tracking_code } }];`,
    sqlQuery: `
SELECT tracking_code, status, sender_name, receiver_name,
       sender_region, receiver_region,
       bus_name, bus_route, bus_departure,
       product_description, product_value_tzs
FROM shipments
WHERE tracking_code = $1
LIMIT 1;`,
    sqlParams: ["tracking_code"],
    formatJs: `
const row = $input.first()?.json;
const toolCallId = $('parse_track_shipment').first().json.toolCallId;
let result;
if (!row) {
  result = 'Samahani, hakuna mzigo wenye namba hiyo.';
} else {
  result = \`Mzigo \${row.tracking_code}: \${row.status}. Mtumaji \${row.sender_name} (\${row.sender_region}) → mpokeaji \${row.receiver_name} (\${row.receiver_region}). Basi: \${row.bus_name || 'haijawekwa'}.\`;
}
return [{ json: { results: [{ toolCallId, result, status: row?.status }] } }];`,
  },
];

// ---- Generator -----------------------------------------------------------
const X = { wh: 240, parse: 480, db: 720, fmt: 980, resp: 1240 };
const Y_STEP = 220;

const nodes = [];
const connections = {};

tools.forEach((t, i) => {
  const y = 100 + i * Y_STEP;
  const safe = t.name.replace(/[^a-z0-9_]/gi, "_");

  const idWh    = `wh_${safe}`;
  const idParse = `parse_${safe}`;
  const idDb    = `db_${safe}`;
  const idFmt   = `fmt_${safe}`;
  const idResp  = `resp_${safe}`;

  nodes.push({
    parameters: { httpMethod: "POST", path: t.parsePath, responseMode: "responseNode", options: {} },
    id: idWh, name: idWh, type: "n8n-nodes-base.webhook",
    typeVersion: 2, position: [X.wh, y], webhookId: idWh,
  });

  nodes.push({
    parameters: { jsCode: `${PARSE_BOOT}\n${t.parseExtra.trim()}` },
    id: idParse, name: idParse, type: "n8n-nodes-base.code",
    typeVersion: 2, position: [X.parse, y],
  });

  const paramExpr = t.sqlParams.map(p => `={{ $json.${p} }}`).join(",");
  nodes.push({
    parameters: {
      operation: "executeQuery",
      query: t.sqlQuery.trim(),
      options: { queryReplacement: paramExpr },
    },
    id: idDb, name: idDb, type: "n8n-nodes-base.postgres",
    typeVersion: 2.5, position: [X.db, y],
    credentials: { postgres: { id: "REPLACE_PG_CREDENTIAL_ID", name: "Pawa Supabase Postgres" } },
  });

  nodes.push({
    parameters: { jsCode: t.formatJs.trim() },
    id: idFmt, name: idFmt, type: "n8n-nodes-base.code",
    typeVersion: 2, position: [X.fmt, y],
  });

  nodes.push(RESPOND_NODE(idResp, X.resp, y));

  // Wire: wh → parse → db → fmt → resp
  connections[idWh]    = { main: [[{ node: idParse, type: "main", index: 0 }]] };
  connections[idParse] = { main: [[{ node: idDb,    type: "main", index: 0 }]] };
  connections[idDb]    = { main: [[{ node: idFmt,   type: "main", index: 0 }]] };
  connections[idFmt]   = { main: [[{ node: idResp,  type: "main", index: 0 }]] };
});

// ---- Inactive AT-SMS sender (separate chain wired off the send-ticket fmt)
// The format node already returns the human "result" to VAPI; the SMS push
// is fire-and-forget on a parallel branch. Enable in n8n once AT creds are
// in. Kept disabled so importing the workflow doesn't 4xx without creds.
const Y_SMS = 100 + 3 * Y_STEP; // line up with send_ticket_sms row
const atNodeId = "at_send_sms_DISABLED";
nodes.push({
  parameters: {
    method: "POST",
    url: "https://api.africastalking.com/version1/messaging",
    sendHeaders: true,
    headerParameters: { parameters: [
      { name: "apiKey",       value: "={{ $env.AT_API_KEY }}" },
      { name: "Accept",       value: "application/json" },
      { name: "Content-Type", value: "application/x-www-form-urlencoded" },
    ]},
    sendBody: true,
    contentType: "form-urlencoded",
    bodyParameters: { parameters: [
      { name: "username", value: "={{ $env.AT_USERNAME }}" },
      { name: "to",       value: "={{ $json._sms.to }}" },
      { name: "message",  value: "={{ $json._sms.body }}" },
      { name: "from",     value: "={{ $env.AT_SHORTCODE }}" },
    ]},
    options: {},
  },
  id: atNodeId, name: atNodeId, type: "n8n-nodes-base.httpRequest",
  typeVersion: 4.2, position: [X.resp + 260, Y_SMS],
  disabled: true,
});
// Fan-out from fmt_send_ticket_sms → respond AND at_send_sms (disabled).
connections["fmt_send_ticket_sms"] = {
  main: [[
    { node: "resp_send_ticket_sms",   type: "main", index: 0 },
    { node: atNodeId,                  type: "main", index: 0 },
  ]],
};

// ---- Emit ----------------------------------------------------------------
const workflow = {
  name: "Pawa VAPI Tools v2 (live-schema)",
  nodes,
  connections,
  settings: { executionOrder: "v1" },
  active: false,
  versionId: "pawa-vapi-tools-v2",
  meta: { instanceId: "pawa-bus-cargo" },
  tags: [],
};

fs.writeFileSync(OUT, JSON.stringify(workflow, null, 2));
console.log(`Wrote ${OUT}`);
console.log(`Tools: ${tools.map(t=>t.name).join(", ")}`);
console.log(`Total nodes: ${nodes.length}`);
