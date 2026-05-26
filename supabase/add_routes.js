const https = require('https');
const PAT = process.env.SUPABASE_PAT;
if (!PAT) {
  console.error("SUPABASE_PAT env var not set. Get a PAT at https://supabase.com/dashboard/account/tokens");
  process.exit(1);
}

const updates = [
  { id: 'BUS001', routes: [
    {from:"Dar es Salaam",to:"Dodoma",departure:"07:00",duration_hours:6},
    {from:"Dodoma",to:"Dar es Salaam",departure:"07:00",duration_hours:6},
    {from:"Dar es Salaam",to:"Moshi",departure:"06:30",duration_hours:9},
    {from:"Moshi",to:"Dar es Salaam",departure:"06:30",duration_hours:9}
  ]},
  { id: 'BUS002', routes: [
    {from:"Arusha",to:"Dar es Salaam",departure:"07:00",duration_hours:10},
    {from:"Dodoma",to:"Dar es Salaam",departure:"08:30",duration_hours:6},
    {from:"Mtwara",to:"Dar es Salaam",departure:"06:30",duration_hours:8},
    {from:"Tanga",to:"Dar es Salaam",departure:"09:00",duration_hours:5},
    {from:"Morogoro",to:"Dar es Salaam",departure:"10:00",duration_hours:3},
    {from:"Dar es Salaam",to:"Tabora",departure:"06:00",duration_hours:12},
    {from:"Tabora",to:"Dar es Salaam",departure:"06:00",duration_hours:12}
  ]},
  { id: 'BUS003', routes: [
    {from:"Kilimanjaro",to:"Dar es Salaam",departure:"06:00",duration_hours:9},
    {from:"Dar es Salaam",to:"Moshi",departure:"06:30",duration_hours:9},
    {from:"Moshi",to:"Dar es Salaam",departure:"06:30",duration_hours:9},
    {from:"Moshi",to:"Arusha",departure:"08:00",duration_hours:1},
    {from:"Arusha",to:"Moshi",departure:"08:00",duration_hours:1}
  ]},
  { id: 'BUS004', routes: [
    {from:"Arusha",to:"Dar es Salaam",departure:"07:30",duration_hours:10},
    {from:"Arusha",to:"Tanga",departure:"08:00",duration_hours:6},
    {from:"Manyara",to:"Arusha",departure:"09:00",duration_hours:3},
    {from:"Dar es Salaam",to:"Manyara",departure:"06:00",duration_hours:12},
    {from:"Manyara",to:"Dar es Salaam",departure:"13:00",duration_hours:12}
  ]},
  { id: 'BUS005', routes: [
    {from:"Dodoma",to:"Dar es Salaam",departure:"07:00",duration_hours:6},
    {from:"Singida",to:"Dodoma",departure:"07:00",duration_hours:4},
    {from:"Tabora",to:"Dodoma",departure:"06:00",duration_hours:8},
    {from:"Dodoma",to:"Mwanza",departure:"06:00",duration_hours:10},
    {from:"Mwanza",to:"Dodoma",departure:"06:00",duration_hours:10}
  ]},
  { id: 'BUS006', routes: [
    {from:"Iringa",to:"Dar es Salaam",departure:"07:00",duration_hours:9},
    {from:"Iringa",to:"Mbeya",departure:"10:00",duration_hours:3},
    {from:"Mbeya",to:"Iringa",departure:"10:00",duration_hours:3}
  ]},
  { id: 'BUS007', routes: [
    {from:"Tabora",to:"Mwanza",departure:"07:00",duration_hours:7},
    {from:"Kagera",to:"Mwanza",departure:"08:00",duration_hours:6},
    {from:"Kigoma",to:"Mwanza",departure:"06:00",duration_hours:12},
    {from:"Mwanza",to:"Dar es Salaam",departure:"07:00",duration_hours:18},
    {from:"Dar es Salaam",to:"Mwanza",departure:"07:00",duration_hours:18}
  ]},
  { id: 'BUS008', routes: [
    {from:"Mbeya",to:"Dar es Salaam",departure:"06:30",duration_hours:14},
    {from:"Iringa",to:"Mbeya",departure:"08:00",duration_hours:4},
    {from:"Dar es Salaam",to:"Iringa",departure:"07:00",duration_hours:9},
    {from:"Iringa",to:"Dar es Salaam",departure:"07:00",duration_hours:9}
  ]},
  { id: 'BUS009', routes: [
    {from:"Mtwara",to:"Dar es Salaam",departure:"07:00",duration_hours:8},
    {from:"Lindi",to:"Mtwara",departure:"07:00",duration_hours:2},
    {from:"Dar es Salaam",to:"Lindi",departure:"06:30",duration_hours:10},
    {from:"Lindi",to:"Dar es Salaam",departure:"06:30",duration_hours:10}
  ]},
  { id: 'BUS010', routes: [
    {from:"Kigoma",to:"Mwanza",departure:"07:00",duration_hours:12},
    {from:"Kagera",to:"Kigoma",departure:"08:00",duration_hours:10}
  ]},
  { id: 'BUS011', routes: [
    {from:"Mwanza",to:"Dar es Salaam",departure:"06:00",duration_hours:18},
    {from:"Dar es Salaam",to:"Dodoma",departure:"06:30",duration_hours:6},
    {from:"Dodoma",to:"Dar es Salaam",departure:"06:30",duration_hours:6}
  ]},
  { id: 'BUS013', routes: [
    {from:"Arusha",to:"Dar es Salaam",departure:"06:30",duration_hours:10},
    {from:"Mbeya",to:"Dar es Salaam",departure:"06:00",duration_hours:14},
    {from:"Iringa",to:"Mbeya",departure:"10:00",duration_hours:3},
    {from:"Mbeya",to:"Iringa",departure:"10:00",duration_hours:3}
  ]},
  { id: 'BUS014', routes: [
    {from:"Arusha",to:"Dar es Salaam",departure:"06:00",duration_hours:10},
    {from:"Mwanza",to:"Arusha",departure:"06:00",duration_hours:12},
    {from:"Dar es Salaam",to:"Moshi",departure:"06:00",duration_hours:9},
    {from:"Moshi",to:"Dar es Salaam",departure:"06:00",duration_hours:9}
  ]},
  { id: 'BUS015', routes: [
    {from:"Mwanza",to:"Geita",departure:"09:00",duration_hours:2},
    {from:"Geita",to:"Mwanza",departure:"09:00",duration_hours:2},
    {from:"Mwanza",to:"Bukoba",departure:"07:00",duration_hours:6},
    {from:"Bukoba",to:"Mwanza",departure:"07:00",duration_hours:6}
  ]}
];

function runQuery(sql) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query: sql });
    const opts = {
      hostname: 'api.supabase.com',
      path: '/v1/projects/kkdpacoiwntrcukgwksh/database/query',
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(opts, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => resolve({ status: r.statusCode, body: d }));
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

(async () => {
  for (const u of updates) {
    const sql = `UPDATE buses SET routes = routes || '${JSON.stringify(u.routes)}'::jsonb WHERE id = '${u.id}';`;
    const r = await runQuery(sql);
    console.log(u.id, r.status, r.body.slice(0, 80));
  }
  console.log('Done.');
})();
