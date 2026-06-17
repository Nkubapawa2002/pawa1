// End-to-end check of the meet/locate room-creation path against the LIVE DB,
// using the same anon client + columns the browser uses (js/meet.js).
// Run:  node tests/test-meet-rooms.mjs
// It inserts a throwaway room per UI purpose value, reports pass/fail, then
// deletes the rooms it managed to create (cleanup). Read-only on failure.
import { createClient } from "@supabase/supabase-js";

const URL  = "https://kkdpacoiwntrcukgwksh.supabase.co";
const ANON = "sb_publishable_qDfG71jBmWEG-JA_Xdh2MA_m6krC_8o";
const sb = createClient(URL, ANON);

// Every purpose value meet.html / meet.js can emit (incl. the locate flow).
const PURPOSES = ["viewing", "service", "agent", "handover", "meet"];

function code() {
  const a = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  return "T" + Array.from({ length: 5 }, () => a[Math.floor(Math.random() * a.length)]).join("");
}

const created = [];
let failures = 0;

for (const purpose of PURPOSES) {
  const c = code();
  // Mirrors createRoom(): code, purpose, tracking_code(null), created_by.
  const { error } = await sb.from("meet_rooms").insert({
    code: c, purpose, tracking_code: null, created_by: "test-meet-rooms",
  });
  if (error) {
    failures++;
    console.log(`✗ purpose="${purpose}"  REJECTED  [${error.code}] ${error.message}`);
  } else {
    created.push(c);
    console.log(`✓ purpose="${purpose}"  created (${c})`);
  }
}

// Cleanup anything we inserted (RLS allows public delete? if not, they expire in 24h).
if (created.length) {
  const { error } = await sb.from("meet_rooms").delete().in("code", created);
  console.log(error ? `\n(cleanup skipped: ${error.message} — rows auto-expire in 24h)` : `\ncleaned up ${created.length} test room(s)`);
}

console.log(`\nResult: ${PURPOSES.length - failures}/${PURPOSES.length} purposes accepted.`);
process.exit(failures ? 1 : 0);
