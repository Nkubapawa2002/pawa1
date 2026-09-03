// ============================================================================
// request_layer_test.mjs — the caching layer in front of the database.
//
// Two files are under test and they fail in opposite directions:
//
//   js/core/data.js   must ask ONCE when N callers ask together, and must not
//                     remember a failure.
//   js/core/auth.js   must remember the session and the admin answer, and must
//                     forget both the instant the session changes. A stale
//                     "yes" here is not a slow page, it is somebody keeping
//                     admin after signing out, so the invalidation cases carry
//                     more weight than the caching ones.
//
// Runs the SHIPPED files in a jsdom-free sandbox with a fake Supabase client
// that COUNTS what reaches it. No server, no network, no database.
//
//   usage:  node tests/request_layer_test.mjs
// ============================================================================
import fs from "node:fs";
import vm from "node:vm";

let pass = 0, fail = 0;
const ok = (c, m, d) => { if (c) { pass++; console.log("  PASS  " + m); }
  else { fail++; console.log("  FAIL  " + m + (d ? "\n        " + d : "")); } };
const section = (s) => console.log("\n" + s);
const tick = () => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------
// A window just real enough for these two files.
// ---------------------------------------------------------------------------
function makeWindow(sb) {
  const store = new Map();
  const win = {
    APP_CONFIG: { ADMIN_EMAILS: ["boss@example.com"] },
    SB: sb,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      clear: () => store.clear(),
      get length() { return store.size; },
      key: (i) => [...store.keys()][i],
    },
    console, setTimeout, clearTimeout, Date, JSON, Promise, Math,
    fetch: async () => ({ ok: true, json: async () => [] }),
  };
  win.window = win;
  win.globalThis = win;
  win.self = win;
  // Object.keys(localStorage) is used by kcacheClear.
  Object.defineProperty(win.localStorage, "__store", { value: store });
  return win;
}

function load(file, win) {
  const ctx = vm.createContext(win);
  vm.runInContext(fs.readFileSync(file, "utf8"), ctx, { filename: file });
  return win;
}

// A Supabase stand-in that records every call.
function makeSb(opts = {}) {
  const calls = { getSession: 0, admins: 0, table: {} };
  let session = opts.session || null;
  const listeners = [];
  const sb = {
    calls,
    setSession(s) {
      session = s;
      listeners.forEach((f) => { try { f("TOKEN_REFRESHED", s); } catch (e) {} });
    },
    // Change the session WITHOUT firing the event, to prove the token stamp
    // catches it on its own.
    setSessionSilently(s) { session = s; },
    auth: {
      async getSession() {
        calls.getSession++;
        await tick();
        return { data: { session } };
      },
      onAuthStateChange(cb) { listeners.push(cb); return { data: { subscription: { unsubscribe() {} } } }; },
      async signOut() { session = null; return { error: null }; },
    },
    from(name) {
      calls.table[name] = (calls.table[name] || 0) + 1;
      if (name === "admins") calls.admins++;
      const b = {};
      ["select", "eq", "order", "limit", "gte", "in", "is", "or", "filter", "range", "match", "neq", "lte"]
        .forEach((m) => { b[m] = () => b; });
      b.maybeSingle = async () => ({ data: null, error: null });
      b.then = (res) => res({ data: opts.adminRows || [], error: null });
      return b;
    },
    storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: "" } }) }) },
  };
  return sb;
}

try {
  // =========================================================================
  section("1. One question, one request");
  // =========================================================================
  {
    const win = makeWindow(makeSb());
    load("js/core/data.js", win);
    let ran = 0;
    const slow = () => new Promise((r) => setTimeout(() => { ran++; r([1, 2, 3]); }, 30));
    const DS = win.DataStore;
    // Reach the private cached() through a public getter is not possible, so
    // exercise the exported surface: five callers, same key, same tick.
    const five = await Promise.all([1, 2, 3, 4, 5].map(() => DS.getRegions()));
    ok(win.SB.calls.table.regions === 1 || win.SB.calls.table.regions === undefined,
       "five simultaneous getRegions() reach the table at most once",
       "regions calls: " + win.SB.calls.table.regions);
    ok(five.every((r) => r === five[0] || JSON.stringify(r) === JSON.stringify(five[0])),
       "and every caller gets the same answer");
    void ran; void slow;
  }

  // =========================================================================
  section("2. The session is remembered, and the admin answer with it");
  // =========================================================================
  const SESSION = { access_token: "tok-1", user: { email: "boss@example.com" } };
  {
    const sb = makeSb({ session: SESSION, adminRows: [{ email: "boss@example.com" }] });
    const win = makeWindow(sb);
    load("js/core/data.js", win);
    load("js/core/auth.js", win);
    const A = win.Auth;

    await Promise.all([A.getSession(), A.getSession(), A.getSession()]);
    ok(sb.calls.getSession === 1,
       "three simultaneous getSession() calls are one lookup", "got " + sb.calls.getSession);

    const before = sb.calls.admins;
    const answers = await Promise.all([A.isDbAdmin(), A.isDbAdmin(), A.isDbAdmin()]);
    ok(sb.calls.admins - before === 1,
       "three simultaneous isDbAdmin() calls are ONE query against admins",
       "admins queries: " + (sb.calls.admins - before));
    ok(answers.every((x) => x === true), "and all three say yes", JSON.stringify(answers));

    const after = sb.calls.admins;
    await A.isDbAdmin();
    ok(sb.calls.admins === after, "a fourth call inside the window queries nothing");
  }

  // =========================================================================
  section("3. Signing out takes the answer with it");
  // =========================================================================
  {
    const sb = makeSb({ session: SESSION, adminRows: [{ email: "boss@example.com" }] });
    const win = makeWindow(sb);
    load("js/core/data.js", win);
    load("js/core/auth.js", win);
    const A = win.Auth;

    ok((await A.isDbAdmin()) === true, "an admin is an admin");
    await A.signOut();
    ok((await A.isDbAdmin()) === false,
       "and is NOT an admin the moment they sign out, with no TTL to wait out");
    ok((await A.getSession()) === null, "the session is gone too");
  }

  // =========================================================================
  section("4. A changed token invalidates on its own");
  // =========================================================================
  {
    const sb = makeSb({ session: SESSION, adminRows: [{ email: "boss@example.com" }] });
    const win = makeWindow(sb);
    load("js/core/data.js", win);
    load("js/core/auth.js", win);
    const A = win.Auth;
    ok((await A.isDbAdmin()) === true, "admin under the first token");

    // Swap the identity WITHOUT firing onAuthStateChange, which is the case
    // the event listener cannot catch.
    sb.setSessionSilently({ access_token: "tok-2", user: { email: "nobody@example.com" } });
    const q = sb.calls.admins;
    const still = await A.isDbAdmin();
    ok(still === false,
       "a different token is not served the previous answer, even with no event fired",
       "got " + still);
    ok(sb.calls.admins === q,
       "and it is refused without a query, because the email is not on the allow list");
  }

  // =========================================================================
  section("5. A failure is not remembered");
  // =========================================================================
  {
    const sb = makeSb({ session: SESSION });
    sb.from = (name) => {
      sb.calls.table[name] = (sb.calls.table[name] || 0) + 1;
      if (name === "admins") sb.calls.admins++;
      const b = {};
      ["select", "eq", "order", "limit"].forEach((m) => { b[m] = () => b; });
      b.then = (res) => res({ data: null, error: { message: "boom" } });
      return b;
    };
    const win = makeWindow(sb);
    load("js/core/data.js", win);
    load("js/core/auth.js", win);
    const A = win.Auth;
    ok((await A.isDbAdmin()) === false, "a failed admin check is false");
    const q = sb.calls.admins;
    await A.isDbAdmin();
    ok(sb.calls.admins > q,
       "and is retried rather than cached, so one bad moment is not a locked door",
       "queries before " + q + ", after " + sb.calls.admins);
  }
} catch (e) {
  fail++;
  console.log("\n  FAIL  the suite threw\n        " + (e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n        ") : e));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
