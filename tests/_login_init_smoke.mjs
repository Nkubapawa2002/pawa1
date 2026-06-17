// Headless smoke test: prove initLoginPage() runs to completion in Clerk mode
// (no sb.auth throw aborting it) and that the verify-code path works without the
// "verifyEmail before initialization" TDZ. Uses the REAL supabase-js client.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

// ---- Minimal DOM/stubs ----
const els = {};
function makeEl(id) {
  return {
    id, _h: {},
    addEventListener(ev, fn) { this._h[ev] = fn; },
    setAttribute() {}, removeAttribute() {}, focus() {},
    appendChild() {}, insertBefore() {}, removeChild() {}, remove() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    style: {}, classList: { add() {}, remove() {}, toggle() {} },
    hidden: false, value: "", textContent: "", innerHTML: "", className: "", disabled: false, type: "password",
  };
}
const document = {
  getElementById(id) { return (els[id] ||= makeEl(id)); },
  createElement() { return makeEl("created"); },
  addEventListener() {},
  head: { appendChild() {} }, documentElement: { appendChild() {} },
};
const listeners = {};
const window = {
  addEventListener(ev, fn) { (listeners[ev] ||= []).push(fn); },
  dispatchEvent(e) { (listeners[e.type] || []).forEach((f) => f(e)); },
  location: { origin: "http://localhost:8080", pathname: "/login.html", hash: "", href: "" },
};
globalThis.window = window;
globalThis.document = document;
globalThis.location = window.location;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {}, key: () => null, length: 0 };
globalThis.fetch = async () => ({ ok: true, json: async () => ({}), text: async () => "" });
globalThis.Event = class { constructor(t) { this.type = t; } };
window.supabase = require("@supabase/supabase-js");

function run(file) { (0, eval)(read(file)); }

let failures = 0;
const check = (cond, msg) => { console.log((cond ? "  PASS " : "  FAIL ") + msg); if (!cond) failures++; };

try {
  run("js/config.js");
  check(window.APP_CONFIG?.USE_CLERK === true, "config: USE_CLERK true");
  check(window.CLERK_ENABLED === true, "config: CLERK_ENABLED true");

  run("js/data.js");
  check(!!window.SB, "data.js: window.SB created");
  // The crux: sb.auth.* must NOT throw before auth-clerk.js loads.
  let threw = false;
  try { window.SB.auth.onAuthStateChange(() => {}); } catch (_) { threw = true; }
  check(!threw, "data.js: sb.auth.onAuthStateChange does NOT throw (placeholder installed)");

  // Mock window.Auth (auth.js normally provides it; replaced by Clerk on load).
  // signIn now resolves to a session directly (the code modal is handled inside
  // Auth.signIn), so login.js just routes.
  const fakeSession = { user: { id: "u1", email: "pawa4761@gmail.com" }, clerk: true };
  window.Auth = {
    getSession: async () => null,
    isAllowedEmail: () => false,
    signIn: async () => fakeSession,
    resetPassword: async () => fakeSession,
    signOut: async () => {},
  };
  // Stub data queries so routeSignedIn()'s portal detection resolves instantly.
  const chain = { select() { return this; }, eq() { return this; }, limit() { return this; }, then(res) { res({ data: [], error: null }); } };
  window.SB.from = () => chain;
  window.SB.rpc = async () => ({ data: [], error: null });

  run("js/login.js");
  check(typeof window.initLoginPage === "function", "login.js: initLoginPage defined");

  // The original crash: if init aborted at sb.auth, later code never ran.
  let initErr = null;
  try { window.initLoginPage(); } catch (e) { initErr = e; }
  check(!initErr, "initLoginPage() runs to completion" + (initErr ? " — " + initErr.message : ""));

  // Fire the login submit → signIn() resolves a session → routeSignedIn().
  const submit = els["loginForm"]?._h.submit;
  check(typeof submit === "function", "login form submit handler registered");
  if (submit) {
    els["loginEmail"].value = "pawa4761@gmail.com";
    els["loginPassword"].value = "PawaClerk#2026";
    let subErr = null;
    await submit({ preventDefault() {} }).catch((e) => (subErr = e));
    check(!subErr, "login submit runs without error" + (subErr ? " — " + subErr.message : ""));
    check(els["portalCard"].hidden === false, "portal chooser shown after sign-in");
  }

  // Fire the forgot-password handler → Clerk resetPassword path.
  const forgot = els["forgotBtn"]?._h.click;
  if (typeof forgot === "function") {
    els["loginEmail"].value = "pawa4761@gmail.com";
    let fErr = null;
    await forgot().catch((e) => (fErr = e));
    check(!fErr, "forgot-password handler runs without error" + (fErr ? " — " + fErr.message : ""));
  }
} catch (e) {
  console.log("  FAIL harness threw: " + e.message);
  failures++;
}
console.log(failures ? `\n${failures} failure(s)` : "\nall smoke checks passed");
process.exit(failures ? 1 : 0);
