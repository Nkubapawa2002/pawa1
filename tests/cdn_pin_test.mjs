// ============================================================================
// cdn_pin_test.mjs — the one third-party script every page loads is pinned.
//
// WHAT THIS GUARDS
// All 27 pages load the Supabase client from jsDelivr. It used to be requested
// as `@supabase/supabase-js@2` — a RANGE. Whatever npm published as the newest
// 2.x is what a visitor's browser executed, with the whole session, every
// listing and every encrypted message going through it. Nobody here chose the
// version, nobody reviewed it, and it could change between two page loads.
//
// Pinning an exact version closes that: npm versions are immutable, so the
// bytes for 2.116.0 are the bytes for 2.116.0, and moving to a new release
// becomes a deliberate edit that shows up in a diff.
//
// WHY THERE IS NO integrity= HASH, AND WHY ADDING ONE IS NOT A TIDY-UP.
// Subresource Integrity is the obvious next step and it would break 34 test
// suites, all at once, with an error that points nowhere near the change.
//
// Those 34 suites answer the CDN script URL with their own stub — that is how
// a lockout, a wrong password or an empty catalogue is produced on demand
// instead of waited for. SRI validates whatever bytes actually arrive, so a
// stub fails the digest and the browser refuses to run the script at all:
// window.supabase never exists and every assertion downstream collapses.
//
// This was measured, not reasoned about. A throwaway page with a known-good
// hash was served four ways through puppeteer request interception:
//
//     no SRI, real file    -> runs
//     no SRI, stubbed      -> runs the stub
//     SRI,    real file    -> runs
//     SRI,    stubbed      -> BLOCKED, "Failed to find a valid digest in the
//                             'integrity' attribute"
//
// So adding integrity means also rewriting how 34 suites stub their way past
// the network. That may well be worth doing one day. It is not a one-line
// hardening, and this comment exists so the next person finds that out here
// rather than from 34 red suites.
//
// WHAT THE PIN DOES AND DOES NOT BUY, precisely, because "pinned" is often
// heard as "safe": it closes silent drift and a compromised LATER release. It
// does not cover jsDelivr serving different bytes for the same version — that
// is what SRI would add, and it is the narrower risk of the two.
//
//   usage:  node tests/cdn_pin_test.mjs        (no server, no browser)
// ============================================================================
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  PASS  " + msg); }
  else { fail++; console.log("  FAIL  " + msg + (detail ? "\n        " + detail : "")); }
};

const pages = readdirSync(ROOT).filter((f) => f.endsWith(".html")).sort();
const SB = /<script\s+src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@([^"]+)"/g;

console.log("\n1. Every page that loads Supabase pins an exact version");
const versions = new Map();
const unpinned = [];
for (const f of pages) {
  const html = readFileSync(join(ROOT, f), "utf8");
  SB.lastIndex = 0;
  let m;
  while ((m = SB.exec(html)) !== null) {
    const spec = m[1];
    versions.set(f, spec);
    // x.y.z and nothing else. "2", "^2", "2.x" and "2.116" are all ranges that
    // let somebody else decide what runs in a customer's browser.
    if (!/^\d+\.\d+\.\d+$/.test(spec)) unpinned.push(`${f} -> @${spec}`);
  }
}

ok(versions.size > 0, `found the script on ${versions.size} pages`, String(versions.size));
ok(unpinned.length === 0,
   "none of them asks for a RANGE. A range means npm chooses what a visitor executes, and it can change between two page loads",
   unpinned.join("\n        "));

console.log("\n2. They all agree on the same version");
const distinct = [...new Set(versions.values())];
ok(distinct.length <= 1,
   "one version across every page, so there is a single thing to review and a single thing to bump",
   distinct.length > 1
     ? [...versions].map(([f, v]) => `${f} -> ${v}`).join("\n        ")
     : "");
if (distinct.length === 1) console.log(`        (pinned at ${distinct[0]})`);

console.log("\n3. The path is the package default, not a guess at the build");
{
  // Pinning to @2.116.0/dist/umd/supabase.js looks more explicit and is a
  // DIFFERENT FILE: 218318 bytes against the default's 218610, different hash.
  // The bare URL's default is not the UMD build, so "be explicit" would have
  // shipped code production has never run.
  const withPath = [...versions.keys()].filter((f) =>
    /supabase-js@[^"]*\//.test(readFileSync(join(ROOT, f), "utf8")));
  ok(withPath.length === 0,
     "no page appends a file path after the version. The bare URL is the package default and is what has always been served here",
     withPath.join(", "));
}

console.log("\n4. If an integrity hash is ever added, the stubs must be dealt with first");
{
  // Not a prohibition — a tripwire. See the header: SRI blocks an intercepted
  // stub, and 34 suites depend on intercepting this exact URL. If somebody adds
  // integrity, this points at the work that has to come with it.
  const withSri = [...versions.keys()].filter((f) =>
    /supabase-js@[^>]*integrity=/.test(readFileSync(join(ROOT, f), "utf8")));
  const stubbers = readdirSync(join(ROOT, "tests"))
    .filter((f) => f.endsWith(".mjs") && !f.startsWith("_"))
    .filter((f) => /jsdelivr/i.test(readFileSync(join(ROOT, "tests", f), "utf8")));
  ok(withSri.length === 0,
     `no integrity attribute yet, and ${stubbers.length} suites currently stub this URL. Read this file's header before adding one`,
     withSri.join(", "));
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
