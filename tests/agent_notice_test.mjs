// ============================================================================
// agent_notice_test.mjs — the strip that says one thing at a time.
//
// WHAT IT GUARDS
// --------------
// Eight things could write into the top of an agent dashboard, four of them by
// insertBefore(el, mount.firstChild) on the same node. Nothing capped the
// total. js/lib/agent-notice-strip.js replaced all of it with one card and a
// pager, and the property that makes that worth having is a NUMBER:
//
//   the dashboard is the same height for one notice or for nine.
//
// Three sections, none of which needs a server:
//
//   1. THE LADDER AND THE SORT are pure. The module touches `document` only
//      inside mount(), so it runs here against a five-line window stub.
//   2. THE COPY FITS. Every title must survive one clamped line and every body
//      two, IN BOTH LANGUAGES. Swahili runs longer than English almost
//      everywhere in this app, so without this a translation silently
//      ellipsises and nobody finds out for six months. This is the same
//      reasoning as the dash ratchet in copy_rules_test.mjs.
//   3. THE NINE STATES each produce the notice they should, at the severity
//      they should, and a healthy subscription produces NOTHING.
//
// The height itself is measured in a browser by agent_notice_strip_e2e.mjs.
//
//   usage:  node tests/agent_notice_test.mjs   (no server needed)
// ============================================================================
import { readFileSync } from "node:fs";
import vm from "node:vm";

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; process.stdout.write("  PASS  " + msg + "\n"); }
  else { fail++; process.stdout.write("  FAIL  " + msg + (detail ? "\n        " + detail : "") + "\n"); }
};

// ---------------------------------------------------------------- the i18n
// Read the two blocks out of i18n.js the way copy_rules_test.mjs does, rather
// than importing it: the file is a browser global, not a module.
const I18N = readFileSync("js/core/i18n.js", "utf8");
function stringsFor(lang) {
  // The English block runs to the first `sw:` key group; everything after is
  // Swahili. One pass, keyed by the LAST definition wins for sw and the first
  // for en, which is exactly how the two blocks are laid out.
  const out = {};
  const re = /^ {4}([a-z0-9_]+):\s*"((?:[^"\\]|\\.)*)"/gm;
  let m, seen = 0;
  const all = [];
  while ((m = re.exec(I18N))) all.push([m[1], m[2]]);
  const half = {};
  for (const [k, v] of all) { half[k] = (half[k] || 0) + 1; }
  const firstOf = {}, lastOf = {};
  for (const [k, v] of all) { if (!(k in firstOf)) firstOf[k] = v; lastOf[k] = v; }
  for (const k of Object.keys(firstOf)) out[k] = lang === "en" ? firstOf[k] : lastOf[k];
  void seen;
  return out;
}
const EN = stringsFor("en"), SW = stringsFor("sw");

// ---------------------------------------------------------------- the module
// No document anywhere in module scope. That is what lets this run at all, and
// it is worth keeping true.
function stripIn(strings) {
  const src = readFileSync("js/lib/agent-notice-strip.js", "utf8");
  const ctx = { window: { t: (k) => strings[k] || k }, console };
  ctx.window.window = ctx.window;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx.window.AgentNoticeStrip;
}
function billingIn(strings) {
  // agentBillingNotice lives in config.js, which also builds APP_CONFIG and
  // reaches for document at the bottom. Pull out just the function under a
  // stub that gives it what it reads.
  const src = readFileSync("js/core/config.js", "utf8");
  const start = src.indexOf("window.agentBillingNotice =");
  const end = src.indexOf("window.agentAdminNotices =");
  if (start < 0 || end < 0) throw new Error("agentBillingNotice not found in config.js");
  const ctx = {
    window: {
      t: (k) => strings[k] || k,
      APP_CONFIG: { AGENT_MONTHLY_FEE_TZS: 10000, AGENT_GRACE_HOURS: 48, AGENT_APPROVAL_DAYS: 7,
                    SUPPORT_CONTACTS: [{ whatsapp: "255700000000", phone: "+255 700 000 000" }] },
      formatTZS: (n) => "TZS " + n.toLocaleString("en-GB"),
      agentAdminAction: () => ({ label: strings.anx_admin || "Contact the admin", href: "https://wa.me/255700000000" }),
    },
    console,
  };
  ctx.window.window = ctx.window;
  vm.createContext(ctx);
  vm.runInContext(src.slice(start, end), ctx);
  return ctx.window.agentBillingNotice;
}

const S = stripIn(EN);
const billEn = billingIn(EN), billSw = billingIn(SW);

// =========================================================================
process.stdout.write("\n1. The ladder: what wins the one slot there is\n");
// =========================================================================
const rank = S._rank;
ok(rank({ severity: "fatal" }) < rank({ severity: "blocking" }),
   "a broken page beats a paused account");
ok(rank({ severity: "blocking" }) < rank({ severity: "warn" }),
   "a paused account beats a subscription running down");
ok(rank({ severity: "warn" }) < rank({ severity: "info" }),
   "and that beats an ordinary message");
ok(rank({ severity: "nonsense" }) === rank({ severity: "info" }),
   "an unknown severity lands on info rather than at the top",
   "unknown ranked " + rank({ severity: "nonsense" }));
ok(rank({}) === rank({ severity: "info" }), "so does a missing one");
// There is no "ok" rung on purpose: a healthy account says nothing at all.
ok(rank({ severity: "ok" }) === rank({ severity: "info" }),
   "there is no rung below info, because a healthy account draws nothing");

// =========================================================================
process.stdout.write("\n2. The sort is total, so a poll cannot shuffle the pager\n");
// =========================================================================
const cmp = S._compare;
const at = (s) => new Date(s).toISOString();
const A = { n: { id: "a", severity: "info", at: at("2026-09-01") }, s: 0 };
const B = { n: { id: "b", severity: "info", at: at("2026-09-05") }, s: 0 };
const C = { n: { id: "c", severity: "blocking", at: at("2026-08-01") }, s: 1 };
ok(cmp(C, A) < 0, "a blocking notice outranks a newer ordinary one");
ok(cmp(B, A) < 0, "two of equal severity sort newest first");
ok(cmp(A, B) > 0, "and the comparator is antisymmetric");
const undated = { n: { id: "d", severity: "info", at: null }, s: 0 };
ok(cmp(A, undated) < 0, "an undated notice sorts last within its rung");
ok(cmp(A, A) === 0, "an item equals itself");
// Totality: no two DIFFERENT ids may compare equal, or the sort is unstable
// between renders and the pager index wanders.
const many = ["a", "b", "c", "d", "e"].map((id, i) => ({
  n: { id, severity: i % 2 ? "info" : "warn", at: at("2026-09-0" + (i + 1)) }, s: i % 2,
}));
let ties = 0;
for (const x of many) for (const y of many) if (x !== y && cmp(x, y) === 0) ties++;
ok(ties === 0, "no two different notices ever compare equal", ties + " tie(s)");

// =========================================================================
process.stdout.write("\n3. The nine billing states, and the one that is silent\n");
// =========================================================================
const sev = (r, extra) => { const n = billEn(Object.assign({ reason: r }, extra || {})); return n && n.severity; };
ok(billEn(null) === null, "no billing state at all draws nothing");
ok(billEn({ reason: "none" }) === null, "and neither does reason 'none'");
ok(billEn({ reason: "active", days_left: 40 }) === null,
   "a healthy subscription draws NOTHING, which is the whole point",
   "got " + JSON.stringify(billEn({ reason: "active", days_left: 40 })));
ok(sev("active", { days_left: 7 }) === "warn", "seven days out it becomes a warning");
ok(sev("active", { days_left: 0 }) === "warn", "and on the last day");
ok(sev("preview") === "info", "an account under review is information, not an alarm");
ok(sev("approval_expired") === "blocking", "a closed review window is blocking");
ok(sev("grace") === "warn", "the pay-or-pause grace warns");
ok(sev("grace_expired") === "blocking", "and blocks once it has run out");
ok(sev("deactivated") === "blocking", "a paused account blocks");
ok(sev("expired") === "blocking", "an expired subscription blocks");
ok(sev("cancelled") === "blocking", "so does a cancelled one");
ok(sev("overdue") === "blocking", "and an overdue one");
// The two states the old code lumped in with "expired" must now say their own
// names, or the copy is wrong on two real states.
const cancelled = billEn({ reason: "cancelled" }), expired = billEn({ reason: "expired" });
ok(cancelled.title !== expired.title,
   "cancelled and expired no longer share the word 'expired'",
   cancelled.title + " | " + expired.title);
ok(billEn({ reason: "overdue" }).title !== expired.title, "nor overdue");
// The admin's own reason is the most useful sentence in the most serious state.
ok(billEn({ reason: "deactivated", note: "Please settle August." }).body === "Please settle August.",
   "an admin's deactivation note wins over the generic line");
ok(/off the board/i.test(billEn({ reason: "deactivated" }).body),
   "and the generic line is there when they gave none");
// A day count has to reach the sentence.
ok(/\b3\b/.test(billEn({ reason: "active", days_left: 3 }).title),
   "the day count reaches the headline",
   billEn({ reason: "active", days_left: 3 }).title);
ok(billEn({ reason: "expired" }).id === "sub:expired",
   "the id is stable per state, which is what anchors the pager");
// Every blocking state has to offer a way out.
for (const r of ["approval_expired", "grace_expired", "deactivated", "expired", "cancelled", "overdue"]) {
  const n = billEn({ reason: r });
  if (!n.action) { ok(false, "every blocking state offers an action (" + r + ")"); break; }
}
ok(["approval_expired", "grace_expired", "deactivated", "expired", "cancelled", "overdue"]
   .every((r) => !!billEn({ reason: r }).action),
   "every blocking state offers a way to reach the admin");

// =========================================================================
process.stdout.write("\n4. The copy fits the card, in BOTH languages\n");
// =========================================================================
// The card gives a title ONE clamped line and a body TWO. These are the widths
// that survive at 390px in the app's UI face. They are deliberately tight: a
// headline that wraps is a headline that is too long.
const TITLE_MAX = 46, BODY_MAX = 120;
const KEYS = Object.keys(EN).filter((k) => /^anx_/.test(k));
ok(KEYS.length > 20, "the strip's strings are all in i18n.js", KEYS.length + " keys");

for (const lang of [["en", EN], ["sw", SW]]) {
  const [code, strings] = lang;
  const longTitles = KEYS.filter((k) => /_t$|_t\d$/.test(k) && (strings[k] || "").length > TITLE_MAX);
  const longBodies = KEYS.filter((k) => /_b$|_b\d$/.test(k) && (strings[k] || "").length > BODY_MAX);
  ok(longTitles.length === 0,
     `every ${code} headline fits one line (<= ${TITLE_MAX} chars)`,
     longTitles.map((k) => k + " = " + strings[k].length).join(", "));
  ok(longBodies.length === 0,
     `every ${code} body fits two lines (<= ${BODY_MAX} chars)`,
     longBodies.map((k) => k + " = " + strings[k].length).join(", "));
}

// Both languages, every key. A key defined once is the bug the whole copy rule
// exists to prevent, and copy_rules_test.mjs checks it globally; this checks
// that it is true of the strings this feature added.
const onlyOne = KEYS.filter((k) => EN[k] === SW[k] && !/^\{/.test(EN[k]));
ok(onlyOne.length === 0,
   "no anx_ string is identical in both languages, which would mean it was defined once",
   onlyOne.join(", "));

// A placeholder that is dropped in translation is a sentence with a hole in it.
for (const k of KEYS) {
  const inEn = (EN[k].match(/\{\w+\}/g) || []).sort().join(",");
  const inSw = (SW[k].match(/\{\w+\}/g) || []).sort().join(",");
  if (inEn !== inSw) { ok(false, "placeholders match across languages (" + k + ")", inEn + " vs " + inSw); break; }
}
ok(KEYS.every((k) => (EN[k].match(/\{\w+\}/g) || []).sort().join(",")
                  === (SW[k].match(/\{\w+\}/g) || []).sort().join(",")),
   "every placeholder survives translation");

// The Swahili has to actually be Swahili. A copy-paste of the English is the
// failure this cannot otherwise see.
ok(SW.anx_sub_off_t !== EN.anx_sub_off_t && /akaunti/i.test(SW.anx_sub_off_t),
   "the Swahili is translated, not copied",
   SW.anx_sub_off_t);

// =========================================================================
process.stdout.write("\n5. It says the same things in Swahili\n");
// =========================================================================
ok(billSw({ reason: "active", days_left: 40 }) === null, "silence is silence in both languages");
ok(billSw({ reason: "deactivated" }).severity === "blocking", "and blocking is blocking");
ok(/\b3\b/.test(billSw({ reason: "active", days_left: 3 }).title),
   "the day count reaches the Swahili headline too",
   billSw({ reason: "active", days_left: 3 }).title);
ok(billSw({ reason: "expired" }).title !== billEn({ reason: "expired" }).title,
   "and the two languages actually differ");

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
